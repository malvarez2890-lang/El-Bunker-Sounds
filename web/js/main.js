import { h, icon, clear } from './dom.js';
import { get, post, patch, onUnauthorized, onMutation, errorText } from './api.js';
import { createRouter, bump, TABS } from './router.js';
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
import { diagnostico } from './views/diagnostico.js';

const app = document.getElementById('app');
let router = null;
let badgeTimer = null;

const ROUTES = [
  { re: /^\/?$/, tab: 'inicio', root: true, view: home },
  { re: /^\/explorar$/, tab: 'explorar', root: true, view: explore },
  { re: /^\/lista\/(album|ep|single|artistas)$/, tab: 'explorar', view: lista, loading: 'grid' },
  { re: /^\/biblioteca$/, tab: 'biblioteca', root: true, view: library },
  { re: /^\/favoritos$/, tab: 'biblioteca', view: favorites },
  { re: /^\/recientes$/, tab: 'biblioteca', view: recents },
  { re: /^\/playlists$/, tab: 'biblioteca', view: playlists },
  { re: /^\/playlist\/(\d+)$/, tab: 'biblioteca', view: playlist },
  { re: /^\/buscar$/, tab: 'buscar', root: true, view: search },
  { re: /^\/album\/(\d+)$/, tab: null, view: album },
  { re: /^\/artista\/(\d+)$/, tab: null, view: artist },
  { re: /^\/admin$/, tab: null, fresh: true, view: admin },
  { re: /^\/diagnostico$/, tab: null, view: diagnostico },
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
  const stage = h('main', { id: 'stage' });
  const tabs = [['inicio', '#/', 'home', 'Inicio'], ['explorar', '#/explorar', 'compass', 'Explorar'], ['biblioteca', '#/biblioteca', 'library', 'Biblioteca'], ['buscar', '#/buscar', 'search', 'Buscar']];
  const tabEls = Object.fromEntries(tabs.map(([id, href, ico, label]) => [id, h('a', { class: 'tab', href, onclick: () => { if (router?.atRoot(id)) router.scrollTop(); } }, icon(ico), label)]));
  app.append(
    h('header', { class: 'topbar' }, h('a', { class: 'brand', href: '#/', 'aria-label': 'El Búnker Sound, inicio' }, h('b', null, 'EL BÚNKER'), h('span', null, 'SOUND')), avatar),
    stage,
    h('nav', { class: 'tabbar', 'aria-label': 'Principal' }, ...Object.values(tabEls)));
  mountMini(app);

  const ctx = { me, refresh: () => router?.refresh(), updateBadge };
  router = createRouter({
    routes: ROUTES, stage, ctx,
    onTab(tab) { for (const [id, el] of Object.entries(tabEls)) { if (id === tab) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); } },
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
        me.isAdmin ? item('shield', pending ? `Administración (${pending} pendiente${pending === 1 ? '' : 's'})` : 'Administración', () => go('#/admin')) : null,
        item('logout', 'Cerrar sesión', logout, 'danger')));
  });
}

onUnauthorized(() => { player.reset(); boot(); });
onMutation(bump);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ---- que se sienta como una app: sin zoom, sin que la pantalla "baile" y ajustada al teclado ----
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
// ---- siempre vertical: si el teléfono se gira, la app se contra-gira (iOS no deja bloquear la rotación a una web app) ----
const root = document.documentElement;
function orient() {
  const phone = Math.min(screen.width, screen.height) <= 500;
  const land = phone && window.innerWidth > window.innerHeight;
  const ang = screen.orientation?.angle ?? window.orientation ?? 90;
  const ccw = ang === 90 || ang === -270; // el teléfono giró con la parte de arriba hacia la izquierda
  root.classList.toggle('land', land);
  root.classList.toggle('ccw', land && ccw);
  root.classList.toggle('cw', land && !ccw);
}
window.addEventListener('resize', orient);
window.addEventListener('orientationchange', orient);
screen.orientation?.addEventListener?.('change', orient);
orient();

const vv = window.visualViewport;
if (vv) {
  const fit = () => {
    orient();
    if (root.classList.contains('land')) { root.style.setProperty('--app-h', '100%'); return; }
    document.documentElement.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
    document.body.classList.toggle('kbd', vv.height < window.innerHeight * 0.8);
    if (window.scrollY || vv.offsetTop) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}

// ---- pantalla de carga: el logo se ve un momento y luego se desvanece ----
const splash = document.getElementById('splash');
const t0 = performance.now();
async function start() {
  await boot();
  await Promise.race([router?.ready, new Promise((r) => setTimeout(r, 4000))]);
  const rest = Math.max(0, 1600 - (performance.now() - t0));
  await new Promise((r) => setTimeout(r, rest));
  splash?.classList.add('hide');
  setTimeout(() => splash?.remove(), 600);
}
start();
