// Navegación "de app": cada pantalla es una página que se apila (como en iOS), con transiciones y arrastre con el dedo.
// La URL sigue usando "#/ruta" (así funcionan los enlaces directos y el botón atrás).
import { h, clear } from './dom.js';
import { loadingState, errorState } from './ui.js';

export const TABS = ['inicio', 'explorar', 'biblioteca', 'buscar'];
export const TAB_HASH = { inicio: '#/', explorar: '#/explorar', biblioteca: '#/biblioteca', buscar: '#/buscar' };

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const DUR = reduce ? 1 : 320;
const EASE = 'cubic-bezier(.22,.8,.24,1)';
const ZERO = 'translate3d(0,0,0)';
const tx = (px) => `translate3d(${px}px,0,0)`;

// Cualquier cambio (favorito, playlist, reproducción…) marca las pantallas guardadas como "viejas" para refrescarlas al volver a ellas.
let version = 0;
export const bump = () => { version++; };

let active = null;
/** Botón "volver": retrocede si hay una pantalla debajo; si no, va al inicio. */
export function navBack() {
  if (active?.canGoBack()) history.back();
  else location.hash = '#/';
}

export function createRouter({ routes, stage, onTab, ctx }) {
  const tabPages = new Map();
  let stack = [];
  let queue = Promise.resolve();
  let suppress = null;
  let animating = false;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });

  const top = () => stack[stack.length - 1];
  const width = () => stage.clientWidth || 390;
  const rootRoute = (tab) => routes.find((r) => r.root && r.tab === tab);

  function matchRoute(hash) {
    const path = (hash.replace(/^#/, '') || '/').split('?')[0];
    for (const r of routes) { const m = r.re.exec(path); if (m) return { route: r, params: m.slice(1) }; }
    return { route: routes[0], params: [] };
  }

  function makePage(route, params, hash, tab) {
    const el = h('div', { class: 'page off' });
    stage.append(el);
    return { el, route, params, hash, tab, version: -1, token: 0, dead: false };
  }
  const show = (p) => p.el.classList.remove('off');
  const hide = (p) => { p.el.classList.add('off'); p.el.style.transform = ''; p.el.style.opacity = ''; p.el.classList.remove('shadow'); };
  function destroy(p) {
    p.dead = true; p.el.remove();
    if (tabPages.get(p.tab) === p) tabPages.delete(p.tab);
  }

  /** Carga (o recarga) el contenido de una página. En modo silencioso no muestra "cargando". */
  async function fillPage(page, { silent = false } = {}) {
    const my = ++page.token;
    const v = version;
    if (!silent || !page.el.firstChild) clear(page.el).append(loadingState(page.route.loading));
    try {
      const node = await page.route.view(ctx, ...page.params);
      if (page.dead || my !== page.token) return;
      const st = page.el.scrollTop;
      clear(page.el).append(node);
      page.el.scrollTop = st;
      page.version = v;
    } catch (err) {
      if (page.dead || my !== page.token) return;
      clear(page.el).append(errorState(err, () => fillPage(page)));
    }
  }
  const revealed = (page) => { if (page.version !== version) fillPage(page, { silent: true }); onTab(page.tab); };

  /** Anima un elemento desde donde está hasta "to" y deja el estilo final puesto. */
  function move(el, to) {
    const cs = getComputedStyle(el);
    const a = el.animate([{ transform: cs.transform === 'none' ? ZERO : cs.transform, opacity: cs.opacity }, { transform: to.transform, opacity: to.opacity ?? '1' }],
      { duration: DUR, easing: EASE, fill: 'forwards' });
    return a.finished.then(() => { el.style.transform = to.transform; el.style.opacity = to.opacity && to.opacity !== '1' ? to.opacity : ''; a.cancel(); }).catch(() => {});
  }

  // ---------- transiciones ----------
  async function pushPage(route, params, hash) {
    const parent = top();
    const tab = route.tab ?? parent?.tab ?? 'inicio';
    const page = makePage(route, params, hash, tab);
    stack.push(page);
    fillPage(page);
    const W = width();
    page.el.classList.add('shadow'); show(page); page.el.style.transform = tx(W);
    await Promise.all([move(page.el, { transform: ZERO }), parent && move(parent.el, { transform: tx(-W * 0.3), opacity: '0.55' })]);
    page.el.classList.remove('shadow');
    if (parent) hide(parent);
    onTab(tab);
  }

  async function popPage() {
    const cur = stack.pop();
    const beneath = top();
    const W = width();
    show(beneath); beneath.el.style.transform = tx(-W * 0.3); beneath.el.style.opacity = '0.55';
    cur.el.classList.add('shadow');
    await Promise.all([move(cur.el, { transform: tx(W) }), move(beneath.el, { transform: ZERO })]);
    destroy(cur);
    revealed(beneath);
  }

  async function popToRoot() {
    for (const p of stack.slice(1, -1)) destroy(p); // las del medio se descartan sin animar
    stack = [stack[0], stack[stack.length - 1]];
    return popPage();
  }

  async function switchTab(tab, hash, route, params) {
    const from = top();
    let target = tabPages.get(tab);
    if (!target) { target = makePage(route, params, hash, tab); tabPages.set(tab, target); fillPage(target); }
    else if (target.version !== version) fillPage(target, { silent: true });
    target.hash = hash;
    const dir = TABS.indexOf(tab) >= TABS.indexOf(from.tab) ? 1 : -1;
    const W = width();
    const old = stack;
    stack = [target];
    show(target); target.el.style.transform = tx(dir * W);
    await Promise.all([move(target.el, { transform: ZERO }), move(from.el, { transform: tx(-dir * W) })]);
    for (const p of old) { if (p === target) continue; if (tabPages.get(p.tab) === p) hide(p); else destroy(p); }
    onTab(tab);
  }

  async function handle(hash) {
    if (suppress && hash === suppress) { suppress = null; return; } // un arrastre ya hizo la animación
    suppress = null;
    const cur = top();
    if (cur && cur.hash === hash) return;
    const { route, params } = matchRoute(hash);
    if (stack.length > 1 && stack[stack.length - 2].hash === hash) return popPage();
    if (route.root) {
      if (stack.length > 1 && stack[0].tab === route.tab) return popToRoot();
      return switchTab(route.tab, hash, route, params);
    }
    return pushPage(route, params, hash);
  }

  window.addEventListener('hashchange', onHash);
  function onHash() {
    const hash = location.hash || '#/';
    queue = queue.then(async () => { animating = true; try { await handle(hash); } finally { animating = false; } }).catch((e) => console.error(e));
  }

  // ---------- arrastrar con el dedo ----------
  let g = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || animating || !e.isPrimary) return;
    if (e.target.closest?.('.hscroll, input, textarea, select, [data-noswipe]')) return;
    g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, locked: false, mode: null, dx: 0, vx: 0, lastX: e.clientX, lastT: e.timeStamp };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.locked) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { g = null; return; } // es un scroll vertical
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
      if (!lock(dx, e)) { g = null; return; }
    }
    g.vx = (e.clientX - g.lastX) / Math.max(1, e.timeStamp - g.lastT);
    g.lastX = e.clientX; g.lastT = e.timeStamp; g.dx = dx;
    drag(dx);
  });
  stage.addEventListener('pointerup', (e) => { if (g && e.pointerId === g.id) endGesture(); });
  stage.addEventListener('pointercancel', (e) => { if (g && e.pointerId === g.id) { if (g.locked) endGesture(true); else g = null; } });

  function neighborPage(tab) {
    let p = tabPages.get(tab);
    if (!p) { p = makePage(rootRoute(tab), [], TAB_HASH[tab], tab); tabPages.set(tab, p); fillPage(p); }
    else if (p.version !== version) fillPage(p, { silent: true });
    return p;
  }

  function lock(dx, e) {
    const W = width();
    const cur = top();
    if (stack.length > 1) {
      if (dx <= 0) return false;
      g.mode = 'back'; g.beneath = stack[stack.length - 2];
      show(g.beneath); g.beneath.el.style.transform = tx(-W * 0.3); g.beneath.el.style.opacity = '0.55';
      cur.el.classList.add('shadow');
    } else if (cur.route.root) {
      const dir = dx < 0 ? 1 : -1;
      const j = TABS.indexOf(cur.tab) + dir;
      if (j < 0 || j >= TABS.length) g.mode = 'rubber';
      else { g.mode = 'tab'; g.dir = dir; g.nb = neighborPage(TABS[j]); show(g.nb); g.nb.el.style.transform = tx(dir * W); }
    } else return false;
    try { stage.setPointerCapture(e.pointerId); } catch { /* sin captura */ }
    g.locked = true;
    return true;
  }

  function drag(dx) {
    const W = width(), cur = top().el;
    if (g.mode === 'back') {
      const x = Math.max(0, dx), p = Math.min(1, x / W);
      cur.style.transform = tx(x);
      g.beneath.el.style.transform = tx(-W * 0.3 * (1 - p));
      g.beneath.el.style.opacity = String(0.55 + 0.45 * p);
    } else if (g.mode === 'tab') {
      const x = g.dir > 0 ? Math.min(0, dx) : Math.max(0, dx);
      cur.style.transform = tx(x);
      g.nb.el.style.transform = tx(g.dir * W + x);
    } else cur.style.transform = tx(dx * 0.22);
  }

  async function endGesture(cancelled = false) {
    const { mode, dx, vx, dir, nb, beneath } = g;
    g = null;
    const W = width(), cur = top();
    animating = true;
    try {
      if (mode === 'back') {
        if (!cancelled && (dx > W * 0.33 || vx > 0.55)) {
          stack.pop();
          await Promise.all([move(cur.el, { transform: tx(W) }), move(beneath.el, { transform: ZERO })]);
          destroy(cur);
          suppress = top().hash; history.back();
          revealed(top());
        } else {
          await Promise.all([move(cur.el, { transform: ZERO }), move(beneath.el, { transform: tx(-W * 0.3), opacity: '0.55' })]);
          cur.el.classList.remove('shadow'); hide(beneath);
        }
      } else if (mode === 'tab') {
        const ok = !cancelled && (Math.abs(dx) > W * 0.3 || Math.abs(vx) > 0.5) && Math.sign(dx) === -dir;
        if (ok) {
          await Promise.all([move(cur.el, { transform: tx(-dir * W) }), move(nb.el, { transform: ZERO })]);
          hide(cur); stack = [nb];
          suppress = nb.hash; location.hash = nb.hash;
          onTab(nb.tab);
        } else {
          await Promise.all([move(cur.el, { transform: ZERO }), move(nb.el, { transform: tx(dir * W) })]);
          hide(nb);
        }
      } else await move(cur.el, { transform: ZERO });
    } finally { animating = false; }
  }

  // ---------- arranque ----------
  const hash0 = location.hash || '#/';
  const { route, params } = matchRoute(hash0);
  const tab0 = route.tab ?? 'inicio';
  const first = makePage(route, params, route.root ? TAB_HASH[tab0] : hash0, tab0);
  if (route.root) tabPages.set(tab0, first);
  stack = [first];
  show(first);
  fillPage(first).then(readyResolve, readyResolve);
  onTab(tab0);

  const api = {
    ready,
    canGoBack: () => stack.length > 1,
    atRoot: (tab) => stack.length === 1 && top().tab === tab,
    scrollTop: () => top().el.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }),
    refresh: () => fillPage(top(), { silent: true }),
    stop: () => { window.removeEventListener('hashchange', onHash); for (const p of [...stack, ...tabPages.values()]) p.el.remove(); if (active === api) active = null; },
  };
  active = api;
  return api;
}
