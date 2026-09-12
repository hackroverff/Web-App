/**
 * "I am signed in but it says I am not" — as a screen instead of a support ticket.
 *
 * The app has two ways to carry a session (a cookie, and a bearer copy of the same token), and
 * whether either works depends on things the app cannot see from the outside: the browser's
 * storage rules for this frame, whether a proxy passed Set-Cookie through, whether the request
 * arrived framed. So ask the server what *it* received and show both sides next to each other.
 * Everything here is data the client and server already have; nothing sensitive is exposed —
 * `GET /api/auth/diag` answers with booleans, the store's own phone number at most.
 */
import { h, mount } from './dom.js';
import { t } from './i18n.js';
import { api, inFrame } from './api.js';
import { state } from './store.js';
import { sheet, pill, toast, notice } from './components.js';
import { storageAvailable } from './storage.js';

const ephemeral = (diag) => diag?.request?.storage === 'ephemeral';

function row(label, value, kind) {
  return h(
    'div',
    {
        class: 'row',
        // .row already centres and gaps; this only turns it into a labelled line.
        style: 'justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line)',
      },
    h('span', { class: 'small', text: label }),
    kind ? pill(value, kind) : h('span', { class: 'small', style: 'font-weight:700', text: value }),
  );
}

/**
 * A yes/no row. `soft` marks a "no" that is not a fault on its own — no token was needed because
 * the cookie is doing its job, or storage is irrelevant while the session still validates.
 */
function flagRow(label, value, { soft = false } = {}) {
  return row(label, value ? t('auth.diag_yes') : t('auth.diag_no'), value ? 'ok' : soft ? 'grey' : 'out');
}

/** Pick the one sentence that is actually true, instead of a wall of flags. */
function adviceOf(diag) {
  const stored = storageAvailable();
  if (!diag) return { text: t('auth.diag_unreachable'), kind: 'bad' };
  if (diag.session_valid) return { text: t('auth.diag_advice_fine'), kind: 'ok' };
  if (!diag.cookie_present && !diag.bearer_present) {
    return {
      text: inFrame && !stored
        ? t('auth.diag_advice_nostorage')
        : t('auth.diag_advice_nocookie'),
      kind: 'bad',
    };
  }
  return { text: t('auth.diag_advice_lost'), kind: 'warn' };
}

/**
 * Drop every cached copy of the app and reload from the server. The escape hatch for "I can see
 * the change you made" — a service worker with unhashed module URLs can hold an old build through
 * any number of ordinary reloads, and asking someone to dig up DevTools' "clear storage" is not
 * an answer they should need.
 */
async function reloadFresh() {
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
    await Promise.all(regs.map((reg) => reg.unregister()));
  } catch {
    // Private mode or an insecure origin: nothing to clear, the reload still helps.
  }
  location.reload();
}

export function openSessionCheck() {
  const body = h('div', { class: 'stack' }, h('p', { class: 'small muted', text: t('auth.diag_loading') }));
  const ref = sheet({
    title: t('auth.diag_title'),
    body,
    actions: [h('button', { class: 'btn ghost', text: t('auth.diag_reload'), onclick: () => reloadFresh() })],
  });

  const both = Promise.all([
    api.get('/api/auth/diag', { silent401: true }),
    // The shop and the counter are separate sessions now, so the sheet reports each door it can
    // see — a shopper asking about the counter is how "the owner portal won't open" gets answered.
    // A lost counter credential is the interesting case, so a refusal still renders the row as
    // "no" instead of hiding it.
    state.owner?.signedIn ? api.get('/api/owner/session', { silent401: true }).catch(() => ({ signed_in: false })) : null,
  ]);

  both
    .then(([diag, counter]) => {
      const advice = adviceOf(diag);
      mount(
        body,
        h('p', { class: 'small muted', text: t('auth.diag_intro') }),
        row(
          t('auth.diag_signedin'),
          diag.signed_in_as ? t('auth.diag_yes_as', { who: diag.signed_in_as }) : t('auth.diag_no'),
          diag.signed_in_as ? 'ok' : 'grey',
        ),
        flagRow(t('auth.diag_cookie'), diag.cookie_present, { soft: diag.session_valid }),
        flagRow(t('auth.diag_bearer'), diag.bearer_present, { soft: diag.session_valid }),
        flagRow(t('auth.diag_stored'), storageAvailable()),
        row(t('auth.diag_framing'), inFrame ? t('auth.diag_frame_yes') : t('auth.diag_frame_no'), 'grey'),
        row(t('auth.diag_server_saw'), diag.embedded ? t('auth.diag_frame_yes') : t('auth.diag_frame_no'), 'grey'),
        counter
          ? row(
              t('auth.diag_counter'),
              counter.signed_in ? t('auth.diag_yes_as', { who: counter.staff?.name || t('auth.diag_counter') }) : t('auth.diag_no'),
              counter.signed_in ? 'ok' : 'out',
            )
          : null,
        row(
          t('auth.diag_disk'),
          ephemeral(diag) ? t('auth.diag_disk_ephemeral') : t('auth.diag_disk_persistent'),
          ephemeral(diag) ? 'low' : 'ok',
        ),
        notice(advice.kind, advice.text),
        inFrame
          ? h(
              'a',
              { class: 'chip', href: location.href, target: '_blank', rel: 'noopener', style: 'align-self:flex-start' },
              t('common.open_new_tab'),
            )
          : null,
        state.offline ? h('p', { class: 'tiny muted', text: t('auth.diag_offline') }) : null,
      );
    })
    .catch((err) => {
      mount(body, notice('bad', err.message || t('auth.diag_unreachable')));
    });

  return ref;
}

/** A toast with a way out, used when a write comes back unsigned. */
export function offerSessionCheck() {
  toast(t('auth.diag_offer'), {
    kind: 'bad',
    ms: 12000,
    action: { label: t('auth.check_session'), run: () => openSessionCheck() },
  });
}
