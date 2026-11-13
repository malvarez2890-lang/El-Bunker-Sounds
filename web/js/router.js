// Navegación por "#/ruta" (funciona sin configurar nada especial en el servidor).
import { clear } from './dom.js';
import { loadingState, errorState } from './ui.js';

let fresh = false;
document.addEventListener('click', (e) => { if (e.target.closest?.('a[href^="#/"]')) fresh = true; }, true);
export const markFresh = () => { fresh = true; };

export function startRouter({ routes, mount, onTab, ctx }) {
  const scrolls = new Map();
  let lastHash = location.hash || '#/';
  let token = 0;

  async function render() {
    const my = ++token;
    const path = (location.hash.replace(/^#/, '') || '/').split('?')[0];
    const wasFresh = fresh; fresh = false;
    let match = null;
    for (const r of routes) { const m = r.re.exec(path); if (m) { match = { r, params: m.slice(1) }; break; } }
    if (!match) match = { r: routes[0], params: [] };
    if (match.r.tab) onTab(match.r.tab);
    const box = mount;
    clear(box).append(loadingState(match.r.loading || 'list'));
    box.classList.remove('view-enter');
    try {
      const node = await match.r.view(ctx, ...match.params);
      if (my !== token) return; // el usuario ya fue a otra pantalla
      clear(box).append(node);
    } catch (err) {
      if (my !== token) return;
      clear(box).append(errorState(err, render));
    }
    void box.offsetWidth; box.classList.add('view-enter');
    window.scrollTo(0, wasFresh ? 0 : scrolls.get(location.hash || '#/') || 0);
  }

  const onChange = () => { scrolls.set(lastHash, window.scrollY); lastHash = location.hash || '#/'; render(); };
  window.addEventListener('hashchange', onChange);
  render();
  return { refresh: render, stop: () => window.removeEventListener('hashchange', onChange) };
}
