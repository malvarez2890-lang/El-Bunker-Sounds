import { h, icon, clear } from './dom.js';
import { get, post, patch, onUnauthorized, errorText } from './api.js';
import { startRouter, markFresh } from './router.js';
import { openSheet, promptText, toast, errorState, go } from './ui.js';
import * as player from './player.js';
import { mountMini } from './playerui.js';
import { renderGate, renderPending, renderBlocked } from './views/gate.js';
import home from './views/home.js';
import { explore, lista } from './views/explore.js';
import { album, artist } from './views/album.js';
import { library, favorites, recents, playlists, playlist } from './views/library.js';
import { search } from './views/search.js';
import { admin } from './views/admin.js';

const app = document.getElementById('app');
let router = null;
let badgeTimer = null;

const ROUTES = [
  { re: /^\/?$/, tab: 'inicio', view: home },
  { re: /^\/explorar$/, tab: 'explorar', view: explore },
  { re: /^\/lista\/(album|ep|single|artistas)$/, tab: 'explorar', view: lista, loading: 'grid' },
  { re: /^\/biblioteca$/, tab: 'biblioteca', view: library },
  { re: /^\/favoritos$/, tab: 'biblioteca', view: favorites },
  { re: /^\/recientes$/, tab: 'biblioteca', view: recents },
  { re: /^\/playlists$/, tab: 'biblioteca', view: playlists },
  { re: /^\/playlist\/(\d+)$/, tab: 'biblioteca', view: playlist },
  { re: /^\/buscar$/, tab: 'buscar', view: search },
  { re: /^\/album\/(\d+)$/, tab: null, view: album },
  { re: /^\/artista\/(\d+)$/, tab: null, view: artist },
  { re: /^\/admin$/, tab: null, view: admin },
];

async function logout() {
  try { await post('/api/auth/logout'); } catch { /* da igual */ }
  player.reset();
  history.replaceState(null, '', '/');
  boot();
}

async function boot() {
  router?.stop(); router = null;
  clearInterval(badgeTimer);
  document.body.classList.remove('has-mini');
  let me = null;
  try {
    ({ user: me } = await get('/api/me'));
  } catch (e) {
    if (e.status !== 401) {
      clear(app).append(h('div', { class: 'gate' }, errorState(e, boot)));
      return;
    }
  }
  if (!me) { renderGate(app, { onDone: boot }); return; }
  if (me.status === 'pending') { renderPending(app, me, { onRefresh: boot, onLogout: logout }); return; }
  if (me.status !== 'active') { renderBlocked(app, { onLogout: logout }); return; }
  renderShell(me);
}

function renderShell(me) {
  clear(app);
  const badge = h('span', { class: 'badge', hidden: true });
  const avatar = h('button', { class: 'avatar', 'aria-label': 'Tu perfil', onclick: () => openProfile(me, avatar) }, me.name.slice(0, 1), badge);
  const view = h('main', { id: 'view', tabIndex: -1 });
  const tabs = [['inicio', '#/', 'home', 'Inicio'], ['explorar', '#/explorar', 'compass', 'Explorar'], ['biblioteca', '#/biblioteca', 'library', 'Biblioteca'], ['buscar', '#/buscar', 'search', 'Buscar']];
  const tabEls = Object.fromEntries(tabs.map(([id, href, ico, label]) => [id, h('a', { class: 'tab', href }, icon(ico), label)]));
  app.append(
    h('header', { class: 'topbar' }, h('a', { class: 'brand', href: '#/', 'aria-label': 'El Búnker Sound, inicio' }, h('b', null, 'EL BÚNKER'), h('span', null, 'SOUND')), avatar),
    view,
    h('nav', { class: 'tabbar', 'aria-label': 'Principal' }, ...Object.values(tabEls)));
  mountMini(app);

  const ctx = { me, refresh: () => router?.refresh(), updateBadge };
  let activeTab = 'inicio';
  router = startRouter({
    routes: ROUTES, mount: view, ctx,
    onTab(tab) {
      if (tab) activeTab = tab;
      for (const [id, el] of Object.entries(tabEls)) { if (id === activeTab) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); }
    },
  });

  async function updateBadge() {
    if (!me.isAdmin) return;
    try {
      const { users } = await get('/api/admin/users');
      const n = users.filter((u) => u.status === 'pending').length;
      badge.textContent = String(n); badge.hidden = !n; avatar.dataset.pending = String(n);
    } catch { /* sin badge */ }
  }
  updateBadge();
  if (me.isAdmin) badgeTimer = setInterval(updateBadge, 60000);
  player.restore();
}

function openProfile(me, avatar) {
  openSheet((box, o) => {
    const item = (ico, label, fn, cls = '') => h('button', { class: `menu-item ${cls}`.trim(), onclick: () => { o.close(); fn(); } }, icon(ico), label);
    const pending = Number(avatar.dataset.pending || 0);
    box.append(
      h('div', { class: 'menu-head' }, h('div', { class: 'avatar' }, me.name.slice(0, 1)), h('div', { style: { 'min-width': '0' } }, h('div', { class: 'h2', style: { 'font-size': '16px' } }, me.name), h('div', { class: 'muted small' }, me.email))),
      h('div', { class: 'body' },
        item('edit', 'Cambiar mi nombre', async () => {
          const name = await promptText({ title: 'Tu nombre', value: me.name, maxLength: 40 });
          if (!name) return;
          try { await patch('/api/me', { name }); me.name = name; boot(); } catch (e) { toast(errorText(e)); }
        }),
        me.isAdmin ? item('shield', pending ? `Administración (${pending} pendiente${pending === 1 ? '' : 's'})` : 'Administración', () => { markFresh(); go('#/admin'); }) : null,
        item('logout', 'Cerrar sesión', logout, 'danger')));
  });
}

onUnauthorized(() => { player.reset(); boot(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
