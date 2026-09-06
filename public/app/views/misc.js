/** Offline screen + PWA niceties. */
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { state, set } from '../core/store.js';
import { page, notice, pill, section, kv } from '../core/components.js';
import { money2, shortDate } from '../core/format.js';
import { icons } from '../core/icons.js';
import { go } from '../core/router.js';

export function docTitle() {
  return t('offline.title');
}

export async function offlineView(root) {
  const cached = await cacheSummary();
  const body = h('div', { class: 'stack' });
  mount(body,
    notice('warn', navigator.onLine ? t('offline.back') : t('offline.sub')),
    h('div', { class: 'card pad' },
      h('div', { class: 'row', style: 'gap:10px;align-items:center' },
        h('span', { class: 'ico', style: 'width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:var(--amber-50);color:var(--amber-700)', html: icons.wifiOff }),
        h('div', { style: 'flex:1' },
          h('strong', { text: t('offline.title') }),
          h('div', { class: 'tiny muted', text: t('offline.explain') }))),
      h('div', { class: 'divider' }),
      kv([
        [t('offline.cart'), state.cart?.lines?.length ? `${state.cart.lines.length} ${t('offline.lines')} · ${money2(state.cart.total)}` : t('offline.empty_cart')],
        [t('offline.last_sync'), state.booted ? shortDate(new Date().toISOString()) : '—'],
        [t('offline.cached'), `${cached.entries} ${t('offline.files')}`],
        [t('offline.shell'), cached.shell ? pill(t('offline.ready'), 'ok') : pill(t('offline.pending'), 'low')],
      ])),
    state.cart?.lines?.length
      ? section(t('nav.cart'), h('a', { class: 'linklike', href: '/cart', 'data-link': '', text: t('common.view') }),
        h('div', { class: 'card', style: 'overflow:hidden' },
          ...state.cart.lines.slice(0, 6).map((l, i) => h('div', { class: 'listrow', style: i === 0 ? 'border-top:0' : '' },
            h('span', { class: 'ico', html: icons.bag }),
            h('div', { style: 'flex:1' }, h('strong', { style: 'font-size:13px', text: l.name }), h('div', { class: 'tiny muted', text: `${l.qty} × ${money2(l.unit_price)}` })),
            h('span', { class: 'small strong', text: money2(l.line_total) }))),
          h('div', { class: 'item-row', style: 'background:var(--green-50)' },
            h('span', { class: 'strong', style: 'flex:1', text: t('offline.will_sync') }),
            h('span', { class: 'price', text: money2(state.cart.total) }))))
      : null,
    h('div', { class: 'row', style: 'gap:8px' },
      h('button', {
        class: 'btn', style: 'flex:1', text: t('offline.retry'),
        onclick: async () => {
          set({ offline: !navigator.onLine });
          try {
            const { api } = await import('../core/api.js');
            await api.get('/api/health');
            set({ offline: false });
            toastOnline();
            go('/shop');
          } catch {
            toastOffline();
          }
        },
      }),
      h('a', { class: 'btn secondary', style: 'flex:1', href: '/shop', 'data-link': '', text: t('offline.browse') })),
    h('p', { class: 'tiny muted', style: 'text-align:center', text: t('offline.note') }));

  page({
    root,
    tab: null,
    header: { user: state.user, cart: state.cart },
    children: [h('h1', { style: 'font-size:21px;margin-bottom:10px', text: t('offline.title') }), body],
  });
}

async function cacheSummary() {
  if (!('caches' in window)) return { entries: 0, shell: false };
  try {
    const names = await caches.keys();
    let entries = 0;
    let shell = false;
    for (const name of names) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      entries += keys.length;
      if (keys.some((r) => r.url.endsWith('/index.html'))) shell = true;
    }
    return { entries, shell };
  } catch {
    return { entries: 0, shell: false };
  }
}

function toastOnline() {
  import('../core/components.js').then(({ toast }) => toast(t('offline.connected'), { kind: 'ok' }));
}
function toastOffline() {
  import('../core/components.js').then(({ toast }) => toast(t('offline.still'), { kind: 'bad' }));
}
