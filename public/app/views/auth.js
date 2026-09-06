/** Login, registration (retail vs wholesale), OTP verification, password reset. */
import { h, mount } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { state, set } from '../core/store.js';
import { api } from '../core/api.js';
import { buildForm, langToggle, notice, pill, toast, sheet } from '../core/components.js';
import { go } from '../core/router.js';

export function docTitle() {
  return 'Sign in';
}

const DEMO = [
  { label: 'Priya — retail', mobile: '9840012345', password: 'priya@123', note: 'household' },
  { label: 'Balaji Tiffin — wholesale', mobile: '9840034567', password: 'balaji@123', note: 'approved' },
  { label: 'New Mumbai Stores', mobile: '9840045678', password: 'newmumbai@123', note: 'pending approval' },
  { label: 'Sathvika staff — Karthik', mobile: 'PIN 1234', password: '', note: 'owner side' },
];

function authShell({ title, sub, children }) {
  return h('div', {
    class: 'keypad-wrap',
    style: 'background:radial-gradient(120% 80% at 50% 0%, #f2faf5, #ffffff 62%)',
  },
  h('div', { style: 'width:min(470px,100%)' },
    h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:14px' },
      h('a', { class: 'chip', href: '/', 'data-link': '' }, h('span', { style: 'width:15px', html: icons.back }), t('app.name')),
      langToggle()),
    h('div', { class: 'card', style: 'padding:18px;box-shadow:var(--shadow-2);border-radius:var(--r-xl)' },
      h('div', { class: 'row', style: 'margin-bottom:14px;gap:12px' },
        h('img', { class: 'brandmark', src: '/img/logo.svg', alt: '', width: 44, height: 44 }),
        h('div', {}, h('h1', { style: 'font-size:21px', text: title }), sub ? h('div', { class: 'small muted', text: sub }) : null)),
      ...children)));
}

/* --------------------------------------------------------------------- login -- */
export function loginView(root, { query }) {
  const next = query.next || '/shop';

  const form = buildForm(
    [
      { name: 'mobile', label: t('auth.mobile'), type: 'tel', inputmode: 'numeric', autocomplete: 'tel', maxlength: 14, required: true, hint: '10-digit mobile number' },
      { name: 'password', label: t('auth.password'), type: 'password', autocomplete: 'current-password', required: true },
    ],
    {
      submitLabel: t('auth.signin'),
      onSubmit: async (values, { setError }) => {
        try {
          const res = await api.post('/api/auth/login', { mobile: values.mobile, password: values.password });
          set({ user: res.user, cart: res.cart, settings: res.settings });
          toast(`Welcome back, ${res.user.full_name.split(' ')[0]}`, { kind: 'ok' });
          go(next);
        } catch (err) {
          if (err.code === 'verify_required') return go(`/verify?mobile=${encodeURIComponent(values.mobile)}`);
          setError('password', err.message);
        }
      },
    },
  );

  const demoSheet = () => {
    const handle = sheet({
      title: 'Demo accounts',
      body: h('div', { class: 'stack' },
        h('p', { class: 'small muted', text: 'Seeded for review — passwords are for this demo only.' }),
        ...DEMO.map((d) => h('button', {
          class: 'entry',
          onclick: () => {
            handle.close();
            if (d.mobile.startsWith('PIN')) return go('/owner');
            form.controls.get('mobile').control.value = d.mobile;
            form.controls.get('password').control.value = d.password;
          },
        },
        h('span', { class: 'ico', html: icons[d.mobile.startsWith('PIN') ? 'key' : 'user'] }),
        h('div', {}, h('strong', { text: d.label }), h('div', { class: 'mono', text: d.mobile.startsWith('PIN') ? d.mobile : `${d.mobile} · ${d.password}` })),
        h('span', { class: 'go' }, pill(d.note, 'grey')))),
        h('div', { class: 'demo-note', text: 'Shop owner counter PIN 4321 · owner password sathvika@owner2026' })),
    });
  };

  mount(root, authShell({
    title: t('auth.signin'),
    sub: t('landing.customerSub'),
    children: [
      h('div', { class: 'stack' },
        form.el,
        h('div', { class: 'row', style: 'justify-content:space-between' },
          h('a', { class: 'linklike', href: '/forgot', 'data-link': '', text: t('auth.forgot') }),
          h('a', { class: 'linklike', href: '/register', 'data-link': '', text: t('auth.signup') })),
        h('button', { class: 'demo-note', style: 'width:100%;text-align:left;cursor:pointer;border-style:solid', onclick: demoSheet },
          h('strong', { text: 'Try a demo account →' })),
      ),
    ],
  }));
}

/* ------------------------------------------------------------------ register -- */
export function registerView(root, { query }) {
  let accountType = query.type === 'wholesale' ? 'wholesale' : 'retail';
  const wrap = h('div', { class: 'stack' });
  const typeCards = h('div', { class: 'stack', style: 'gap:8px' });

  const renderTypes = () => {
    mount(typeCards,
      ...[
        ['retail', t('auth.retail'), t('auth.retailSub'), 'bag'],
        ['wholesale', t('auth.wholesale'), t('auth.wholesaleSub'), 'building'],
      ].map(([value, title, sub, ic]) => h('button', {
        type: 'button',
        class: 'payopt',
        'aria-checked': String(accountType === value),
        onclick: () => {
          accountType = value;
          build();
        },
      },
      h('span', { class: 'ico', style: 'width:38px;height:38px;border-radius:10px;display:grid;place-items:center;background:var(--green-50);color:var(--green-700)', html: icons[ic] }),
      h('div', {}, h('strong', { text: title }), h('div', { class: 'tiny muted', text: sub })),
      h('span', { class: 'radio' }))));
  };

  const businessFields = () =>
    (accountType === 'wholesale'
      ? [
        { name: 'business_name', label: t('auth.business_name'), required: true, maxlength: 90, placeholder: 'e.g. Sri Balaji Tiffin Room' },
        {
          name: 'business_type',
          label: t('auth.business_type'),
          type: 'select',
          placeholder: 'Choose one',
          options: [
            ['shop', t('auth.shop')],
            ['restaurant', t('auth.restaurant')],
            ['canteen', t('auth.canteen')],
            ['office', t('auth.office')],
            ['institution', t('auth.institution')],
            ['other', t('auth.other')],
          ].map(([value, label]) => ({ value, label })),
        },
        { name: 'gst_number', label: `${t('auth.gst')} · ${t('common.optional')}`, maxlength: 15, hint: '15 characters, e.g. 33ABCDE1234F1Z5' },
      ]
      : []);

  let form = null;
  const build = () => {
    renderTypes();
    form = buildForm(
      [
        { name: 'full_name', label: t('auth.name'), required: true, maxlength: 80, autocomplete: 'name' },
        { name: 'mobile', label: t('auth.mobile'), type: 'tel', inputmode: 'numeric', maxlength: 14, required: true, autocomplete: 'tel', hint: 'We send a 6-digit code to this number' },
        { name: 'password', label: t('auth.password'), type: 'password', required: true, hint: t('auth.password_hint'), autocomplete: 'new-password' },
        { name: 'confirm_password', label: t('auth.confirm'), type: 'password', required: true, autocomplete: 'new-password' },
        { name: '__type', label: t('auth.account_type'), type: 'html', el: typeCards },
        ...businessFields(),
      ],
      {
        submitLabel: t('auth.register'),
        onSubmit: async (values, { setError }) => {
          try {
            const res = await api.post('/api/auth/register', { ...values, account_type: accountType, lang: state.lang });
            sessionStorage.setItem('smv.verify', JSON.stringify({ mobile: res.mobile, otp: res.otp?.debug_otp || null }));
            go(`/verify?mobile=${encodeURIComponent(res.mobile)}`);
          } catch (err) {
            if (err.fields?.confirm_password) setError('confirm_password', err.message);
            else if (err.fields?.business_name) setError('business_name', err.message);
            else if (err.fields?.gst_number) setError('gst_number', err.message);
            else if (err.fields?.mobile) setError('mobile', err.message);
            else setError('full_name', err.message);
          }
        },
      },
    );
    mount(wrap,
      form.el,
      h('div', { class: 'row', style: 'justify-content:center' },
        h('span', { class: 'small muted', text: t('auth.have_account') }),
        h('a', { class: 'linklike', href: '/login', 'data-link': '', text: t('auth.signin') })));
  };

  build();
  mount(root, authShell({
    title: t('auth.signup'),
    sub: 'Retail for your home, or wholesale for your business',
    children: [wrap, h('div', { class: 'demo-note', text: 'Wholesale accounts start as “Pending verification” and see retail prices until the owner approves the business.' })],
  }));
}

/* -------------------------------------------------------------------- verify -- */
export function verifyView(root, { query }) {
  const stored = safeParse(sessionStorage.getItem('smv.verify')) || {};
  const mobile = query.mobile || stored.mobile || '';
  const debugOtp = stored.otp || null;

  const hint = h('div', {}, debugOtp ? notice('info', `${t('auth.otp_demo')}`, h('div', { class: 'mono', style: 'font-size:20px;letter-spacing:.3em;margin-top:4px', text: debugOtp })) : null);
  const code = h('input', {
    class: 'input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '••••••',
    style: 'text-align:center;letter-spacing:.45em;font-size:24px;font-weight:800;font-family:var(--mono)',
  });
  const countdown = h('span', { class: 'tiny muted' });
  const resend = h('button', { class: 'linklike', text: t('auth.resend') });
  let seconds = 30;
  let timer = null;

  const startCountdown = () => {
    clearInterval(timer);
    seconds = 30;
    resend.disabled = true;
    timer = setInterval(() => {
      seconds -= 1;
      countdown.textContent = seconds > 0 ? `${seconds}s` : '';
      if (seconds <= 0) {
        clearInterval(timer);
        resend.disabled = false;
      }
    }, 1000);
  };

  resend.addEventListener('click', async () => {
    resend.disabled = true;
    try {
      const res = await api.post('/api/auth/resend-otp', { mobile, purpose: 'register' });
      if (res.otp?.debug_otp) {
        sessionStorage.setItem('smv.verify', JSON.stringify({ mobile, otp: res.otp.debug_otp }));
        code.value = res.otp.debug_otp;
        mount(hint, notice('info', t('auth.otp_demo'), h('div', { class: 'mono', style: 'font-size:20px;letter-spacing:.3em;margin-top:4px', text: res.otp.debug_otp })));
      } else {
        toast(res.message || 'Code sent', { kind: 'ok' });
      }
      startCountdown();
    } catch (err) {
      toast(err.message, { kind: 'bad' });
      resend.disabled = false;
    }
  });

  const submit = async () => {
    const value = code.value.replace(/\D/g, '');
    if (value.length !== 6) return toast('Enter the 6-digit code', { kind: 'bad' });
    try {
      const res = await api.post('/api/auth/verify', { mobile, code: value });
      set({ user: res.user, cart: res.cart, settings: res.settings });
      sessionStorage.removeItem('smv.verify');
      toast(res.message || 'Verified', { kind: 'ok' });
      go(res.user.wholesale_pending ? '/profile' : '/shop');
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };
  code.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });

  startCountdown();
  mount(root, authShell({
    title: t('auth.otp_title'),
    sub: `+91 ${mobile}`,
    children: [
      h('div', { class: 'stack' },
        h('p', { class: 'small muted', text: t('auth.otp_sub') }),
        hint,
        code,
        h('div', { class: 'row', style: 'justify-content:space-between' }, countdown, resend),
        h('button', { class: 'btn block', onclick: submit, text: t('auth.verify') }),
        h('div', { class: 'row', style: 'justify-content:center;gap:6px' },
          h('span', { class: 'tiny muted', text: 'Wrong number?' }),
          h('a', { class: 'linklike', href: '/register', 'data-link': '', text: 'Register again' }))),
    ],
  }));
  setTimeout(() => code.focus(), 120);
  return () => clearInterval(timer);
}

/* -------------------------------------------------------------- forgot/reset -- */
export function forgotView(root) {
  const wrap = h('div', { class: 'stack' });
  let sentMobile = '';
  let debugOtp = null;

  const askMobile = () => {
    const form = buildForm(
      [{ name: 'mobile', label: t('auth.mobile'), type: 'tel', inputmode: 'numeric', maxlength: 14, required: true }],
      {
        submitLabel: t('common.next'),
        onSubmit: async (values, { setError }) => {
          try {
            const res = await api.post('/api/auth/forgot', values);
            sentMobile = values.mobile;
            debugOtp = res.otp?.debug_otp || null;
            askCode();
          } catch (err) {
            setError('mobile', err.message);
          }
        },
      },
    );
    mount(wrap, h('p', { class: 'small muted', text: 'Enter your registered mobile number and we will send a 6-digit code.' }), form.el);
  };

  const askCode = () => {
    const form = buildForm(
      [
        { name: 'code', label: 'Verification code', inputmode: 'numeric', maxlength: 6, required: true, value: debugOtp || '' },
        { name: 'password', label: t('auth.new_password'), type: 'password', required: true, hint: t('auth.password_hint'), autocomplete: 'new-password' },
        { name: 'confirm_password', label: t('auth.confirm'), type: 'password', required: true, autocomplete: 'new-password' },
      ],
      {
        submitLabel: t('common.save'),
        onSubmit: async (values, { setError }) => {
          try {
            const res = await api.post('/api/auth/reset-password', { ...values, mobile: sentMobile });
            toast(res.message || 'Password updated', { kind: 'ok' });
            go('/login');
          } catch (err) {
            setError('code', err.message);
          }
        },
      },
    );
    mount(wrap,
      notice(debugOtp ? 'info' : 'ok', `${t('auth.otp_sub')} +91 ${sentMobile}`, debugOtp ? h('div', { class: 'mono', style: 'font-size:18px;letter-spacing:.3em', text: debugOtp }) : null),
      form.el);
  };

  askMobile();
  mount(root, authShell({ title: t('auth.reset_title'), sub: t('auth.forgot'), children: [wrap] }));
}

const safeParse = (json) => {
  try {
    return JSON.parse(json || 'null');
  } catch {
    return null;
  }
};
