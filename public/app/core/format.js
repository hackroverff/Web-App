/** Display formatters. Rupee-first, en-IN grouping, 2-dp only when it matters. */
export const money = (n, { decimals = 'auto' } = {}) => {
  const v = Number(n || 0);
  const dp = decimals === 'auto' ? (Math.abs(v % 1) > 0.004 ? 2 : 0) : decimals;
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
};
export const money2 = (n) => money(n, { decimals: 2 });

export function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(toDate(iso));
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export function dateTime(iso) {
  if (!iso) return '';
  const d = new Date(toDate(iso));
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
}

export function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(toDate(iso)).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (Number.isNaN(mins)) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return shortDate(iso);
}

/** SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC; make it parseable everywhere. */
function toDate(iso) {
  return typeof iso === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(iso) ? `${iso.replace(' ', 'T')}Z` : iso;
}

export function etaText(iso) {
  if (!iso) return '';
  const mins = Math.round((new Date(toDate(iso)).getTime() - Date.now()) / 60000);
  if (mins <= 0) return 'due any time now';
  if (mins < 60) return `in about ${mins} min`;
  return `in about ${Math.round(mins / 60 * 2) / 2} h`;
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('');
}

export const addressOneLine = (a) => (a ? [a.line1, a.line2, a.area, a.city, a.pincode].filter(Boolean).join(', ') : '');
