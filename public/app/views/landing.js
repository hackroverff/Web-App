/** Landing page: brand, the two entry points, catalogue teaser and store trust. */
import { h } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { t, localName } from '../core/i18n.js';
import { state, set } from '../core/store.js';
import { page, langToggle, notice } from '../core/components.js';
import { api } from '../core/api.js';
import { money } from '../core/format.js';

export function docTitle() {
  return 'Sathvika MV';
}

export default async function landing(root, { go }) {
  const featured = state.bootstrap?.featured || [];
  const categories = state.bootstrap?.categories || [];

  const hero = h('section', { class: 'hero' },
    h('div', { class: 'tiny', style: 'letter-spacing:.14em;text-transform:uppercase;opacity:.85;font-weight:700', text: t('landing.kicker') }),
    h('h1', { text: t('landing.title'), style: 'margin:8px 0 6px' }),
    h('p', { style: 'max-width:46ch', text: t('landing.sub') }),
    h('div', { class: 'row', style: 'margin-top:14px;gap:8px;flex-wrap:wrap' },
      h('a', { class: 'btn', style: 'background:#fff;color:var(--green-700)', href: '/shop', 'data-link': '' },
        h('span', { html: icons.bag }), t('landing.browse')),
      h('span', { class: 'tiny', style: 'opacity:.9', text: `${state.bootstrap?.total_products || 0} products · ${state.settings?.shop_open === false ? t('owner.shop_closed') : t('landing.open_today')}` })));

  const entries = h('div', { class: 'stack', style: 'margin-top:16px' },
    h('button', { class: 'entry', onclick: () => (state.user ? go('/shop') : go('/login')) },
      h('span', { class: 'ico', html: icons.user }),
      h('div', {}, h('strong', { text: t('landing.customer') }), h('div', { class: 'small muted', text: t('landing.customerSub') })),
      h('span', { class: 'go', html: icons.arrowRight })),
    h('button', { class: 'entry dark', onclick: () => go('/owner') },
      h('span', { class: 'ico', html: icons.store }),
      h('div', {}, h('strong', { text: t('landing.owner') }), h('div', { class: 'small muted', text: t('landing.ownerSub') })),
      h('span', { class: 'go', html: icons.arrowRight })));

  const trust = h('div', { class: 'trust' },
    ...[
      ['truck', t('landing.trust1')],
      ['wallet', t('landing.trust2')],
      ['tag', t('landing.trust3')],
      ['shield', t('landing.trust4')],
    ].map(([ic, text]) => h('div', { class: 'row' }, h('span', { style: 'width:20px;color:var(--green-600)', html: icons[ic] }), h('span', { text }))));

  const catStrip = categories.length
    ? h('div', { class: 'cat-strip' }, ...categories.map((c) =>
      h('button', {
        class: 'cat-tile',
        onclick: () => go(`/shop?category=${c.id}`),
      },
        h('img', { src: `/img/categories/${slug(c.name)}.svg`, alt: '', width: 52, height: 44, loading: 'lazy' }),
        h('span', { text: state.lang === 'ta' && c.name_ta ? c.name_ta : c.name }))))
    : null;

  const featuredRow = featured.length
    ? h('div', { class: 'grid-products' }, ...featured.slice(0, 4).map((p) =>
      h('button', { class: 'pcard', style: 'text-align:left', onclick: () => go(`/product/${p.id}`) },
        h('div', { class: 'pcard-img' }, h('img', { src: p.image, alt: '', loading: 'lazy' })),
        h('div', { class: 'pcard-body' },
          h('div', { class: 'pcard-brand', text: p.brand || '' }),
          h('div', { class: 'pcard-name', text: localName(p) }),
          h('div', { class: 'pcard-pack', text: p.pack_size || '' }),
          h('div', { class: 'pcard-price' }, h('span', { class: 'price', text: money(p.price) }))))))
    : null;

  const store = state.settings;
  const info = store ? h('div', { class: 'card pad', style: 'margin-top:16px' },
    h('h3', { text: store.store_name }),
    h('p', { class: 'small muted', text: store.store_address }),
    h('div', { class: 'row', style: 'margin-top:8px;flex-wrap:wrap' },
      h('a', { class: 'chip', href: `tel:${String(store.store_phone).replace(/\s/g, '')}` }, h('span', { style: 'width:16px', html: icons.phone }), store.store_phone),
      store.shop_open
        ? h('span', { class: 'chip soft' }, h('span', { class: 'dot open' }), t('owner.shop_open'))
        : h('span', { class: 'chip' }, h('span', { class: 'dot closed' }), t('owner.shop_closed')))) : null;

  const foot = h('footer', { class: 'center tiny muted', style: 'padding:26px 0 10px' },
    h('div', { text: `© ${new Date().getFullYear()} Sathvika MV · T. Nagar, Chennai` }),
    h('div', { class: 'row', style: 'justify-content:center;margin-top:8px' }, langToggle()));

  page({
    root,
    header: { user: state.user, cart: state.cart, subtitle: state.settings?.shop_open === false ? t('owner.shop_closed') : t('app.tagline') },
    children: [
    store && !store.shop_open ? notice('warn', t('closed.banner')) : null,
    hero,
    entries,
    h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: t('landing.why') })), trust),
    catStrip ? h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: t('landing.categories') })), catStrip) : null,
    featuredRow ? h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: t('landing.week') }), h('a', { class: 'linklike spacer', href: '/shop', 'data-link': '' }, t('landing.see_all'))), featuredRow) : null,
    info,
    foot,
    ],
  });

  // Keep the closed/open strip honest without a reload.
  const refresh = async () => {
    const fresh = await api.get('/api/catalog/store').catch(() => null);
    if (fresh) set({ settings: { ...state.settings, shop_open: fresh.open } });
  };
  refresh();
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
