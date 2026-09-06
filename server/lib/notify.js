/**
 * Customer messaging layer (SMS / WhatsApp-style). Every message is written to the
 * `notifications` outbox table so the owner can see exactly what the customer was
 * told — this is what makes the "notify on status change" requirement demoable
 * without paid gateway credentials.
 *
 * Providers:
 *   log      — queue + mark sent in the outbox (default; works on any network)
 *   webhook  — POST to NOTIFY_WEBHOOK_URL, which is where MSG91 / Twilio / Gupshup
 *              / Interakt get wired up in production. No message content is ever
 *              dropped on failure: it stays visible with status `failed`.
 */
import { config } from '../config.js';
import { run, all, get, getSetting } from '../db/index.js';

export const TEMPLATES = {
  otp_generic: {
    en: 'Your Sathvika MV verification code is {{code}}. It is valid for {{minutes}} minutes. Do not share it with anyone.',
    ta: 'உங்கள் சத்விகா MV சரிபார்ப்பு குறியீடு {{code}}. இது {{minutes}} நிமிடங்களுக்கு செல்லுபடியாகும். எவரிடமும் பகிர வேண்டாம்.',
  },
  order_placed: {
    en: 'Order {{order_no}} received. Total ₹{{total}} ({{payment}}). We will confirm shortly. — Sathvika MV',
    ta: 'ஆர்டர் {{order_no}} பெறப்பட்டது. மொத்தம் ₹{{total}} ({{payment}}). சிறிது நேரத்தில் உறுதி செய்வோம். — சத்விகா MV',
  },
  order_confirmed: {
    en: 'Order {{order_no}} confirmed. Arriving in about {{eta}} minutes. — Sathvika MV',
    ta: 'ஆர்டர் {{order_no}} உறுதி செய்யப்பட்டது. சுமார் {{eta}} நிமிடங்களில் வரும். — சத்விகா MV',
  },
  order_preparing: {
    en: 'We are packing your order {{order_no}} now. — Sathvika MV',
    ta: 'உங்கள் ஆர்டர் {{order_no}} இப்போது பேக் செய்யப்படுகிறது. — சத்விகா MV',
  },
  order_out_for_delivery: {
    en: 'Out for delivery! Order {{order_no}} is on the way, about {{eta}} minutes. {{payment_note}} — Sathvika MV',
    ta: 'வழங்கலுக்கு செல்கிறது! ஆர்டர் {{order_no}} வழியில் உள்ளது, சுமார் {{eta}} நிமிடம். {{payment_note}} — சத்விகா MV',
  },
  order_delivered: {
    en: 'Order {{order_no}} delivered. Thank you for shopping with Sathvika MV! Reorder any time from the app.',
    ta: 'ஆர்டர் {{order_no}} வழங்கப்பட்டுவிட்டது. நன்றி! ஆப் மூலம் எப்போது வேண்டுமானாலும் மீண்டும் ஆர்டர் செய்யலாம்.',
  },
  order_cancelled: {
    en: 'Order {{order_no}} was cancelled. Reason: {{reason}}. Any payment will be refunded. — Sathvika MV',
    ta: 'ஆர்டர் {{order_no}} ரத்து செய்யப்பட்டது. காரணம்: {{reason}}. பணம் திரும்ப வழங்கப்படும். — சத்விகா MV',
  },
  wholesale_approved: {
    en: 'Your wholesale account for {{business}} is approved. Wholesale prices and quantity slabs are now unlocked. — Sathvika MV',
    ta: 'உங்கள் மொத்த விற்பனை கணக்கு ({{business}}) அங்கீகரிக்கப்பட்டது. இனி மொத்த விலை மற்றும் சலுகை விலைகள் பொருந்தும். — சத்விகா MV',
  },
  wholesale_rejected: {
    en: 'We could not approve your wholesale account for {{business}}. Reason: {{reason}}. Retail prices still work. — Sathvika MV',
    ta: 'உங்கள் மொத்த விற்பனை கணக்கை ({{business}}) அங்கீகரிக்க முடியவில்லை. காரணம்: {{reason}}. சில்லறை விலைகள் தொடரும். — சத்விகா MV',
  },
  low_stock: {
    en: 'Low stock: {{count}} item(s) need restocking today.',
    ta: 'குறைந்த இருப்பு: இன்று {{count}} பொருட்களை நிரப்ப வேண்டும்.',
  },
};

export function render(templateKey, vars = {}, lang = 'en') {
  const tpl = TEMPLATES[templateKey]?.[lang] || TEMPLATES[templateKey]?.en || templateKey;
  return tpl.replace(/{{(\w+)}}/g, (_m, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
}

export async function sendMessage({ to, body, channel = 'sms', userId = null, orderId = null, template = null }) {
  const provider = config.notify.provider;
  const id = run(
    `INSERT INTO notifications (user_id, order_id, channel, to_number, template, body, status, provider)
     VALUES (?,?,?,?,?,?, 'queued', ?)`,
    [userId, orderId, channel, to, template, body, provider],
  ).lastInsertRowid;

  if (provider === 'webhook' && config.notify.webhookUrl) {
    try {
      const res = await fetch(config.notify.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.notify.webhookToken ? { authorization: `Bearer ${config.notify.webhookToken}` } : {}),
        },
        body: JSON.stringify({ to, message: body, sender: config.notify.senderId, channel, template }),
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      run("UPDATE notifications SET status='sent', sent_at=datetime('now'), provider_msg=? WHERE id=?", [
        `accepted ${(await res.text()).slice(0, 180)}`,
        id,
      ]);
    } catch (err) {
      run("UPDATE notifications SET status='failed', provider_msg=? WHERE id=?", [String(err.message).slice(0, 200), id]);
    }
  } else {
    run("UPDATE notifications SET status='sent', sent_at=datetime('now'), provider_msg=? WHERE id=?", [
      'logged to outbox (no live gateway)',
      id,
    ]);
    if (config.env !== 'test') {
      console.log(`[notify:${channel}] ${to} :: ${body}`);
    }
  }
  return get('SELECT * FROM notifications WHERE id=?', [id]);
}

export function sendOtp({ mobile, code, lang = 'en' }) {
  return sendMessage({
    to: mobile,
    template: 'otp_generic',
    body: render('otp_generic', { code, minutes: config.otpTtlMinutes }, lang),
  });
}

/** Fired on order status changes; never blocks the request if the gateway is down. */
export async function notifyOrderStatus({ order, user, status, extra = {} }) {
  const map = {
    placed: 'order_placed',
    confirmed: 'order_confirmed',
    preparing: 'order_preparing',
    out_for_delivery: 'order_out_for_delivery',
    delivered: 'order_delivered',
    cancelled: 'order_cancelled',
  };
  const template = map[status];
  if (!template || !user) return null;
  const vars = {
    order_no: order.public_id,
    total: Number(order.total).toFixed(0),
    eta: order.eta_minutes ?? getSetting('eta_minutes', '90'),
    payment: order.payment_method === 'cod' ? 'Cash on delivery' : 'Paid by UPI',
    payment_note:
      order.payment_method === 'cod'
        ? 'Keep ₹' + Number(order.total).toFixed(0) + ' ready for the delivery boy.'
        : 'Payment received. Thank you!',
    reason: order.cancel_reason || 'not available',
    business: user.business_name || user.full_name || user.name || 'your account',
    ...extra,
  };
  // One message per order event, in the language the customer picked in the app.
  const lang = user.lang === 'ta' ? 'ta' : 'en';
  const body = render(template, vars, lang);
  return sendMessage({ to: user.mobile, body, template, userId: user.id, orderId: order.id, channel: 'whatsapp' });
}

export function recentNotifications(limit = 40, filters = {}) {
  const where = [];
  const params = [];
  if (filters.orderId) {
    where.push('order_id = ?');
    params.push(Number(filters.orderId));
  }
  if (filters.userId) {
    where.push('user_id = ?');
    params.push(Number(filters.userId));
  }
  const sql = `SELECT * FROM notifications ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY id DESC LIMIT ?`;
  return all(sql, [...params, Math.min(200, Number(limit) || 40)]);
}
