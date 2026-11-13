// Gesto de arrastre con el dedo (táctil). Decide el eje (x o y) y avisa mientras se mueve y al soltar.
let clickGuard = null;
/** Después de un arrastre, el "click" que el navegador dispara al soltar se descarta (para no apretar un botón sin querer). */
function swallowNextClick() {
  const stop = (e) => { e.stopPropagation(); e.preventDefault(); window.removeEventListener('click', stop, true); };
  window.addEventListener('click', stop, true);
  clearTimeout(clickGuard);
  clickGuard = setTimeout(() => window.removeEventListener('click', stop, true), 120); // el click que sigue a un arrastre llega al tiro
}

/**
 * pointerGesture(el, { filter(e), lock(axis, dx, dy, g) -> bool, move(dx, dy, g), end({dx, dy, vx, vy, axis, cancelled}) })
 *  - filter: ¿este toque puede iniciar un gesto?
 *  - lock: se llama una vez, al decidir el eje; devuelve false para ignorar el gesto.
 */
export function pointerGesture(el, { filter = () => true, lock, move, end }) {
  let g = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !e.isPrimary || !filter(e)) return;
    g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, locked: null, lastX: e.clientX, lastY: e.clientY, lastT: e.timeStamp, vx: 0, vy: 0, target: e.target };
  });
  el.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.locked) {
      const ax = Math.abs(dx), ay = Math.abs(dy);
      if (ax < 10 && ay < 10) return;
      const axis = ax > ay * 1.2 ? 'x' : ay > ax * 1.2 ? 'y' : null;
      if (!axis) return;
      if (!lock || !lock(axis, dx, dy, g)) { g = null; return; }
      g.locked = axis;
      try { el.setPointerCapture(e.pointerId); } catch { /* sin captura */ }
    }
    const dt = Math.max(1, e.timeStamp - g.lastT);
    g.vx = (e.clientX - g.lastX) / dt; g.vy = (e.clientY - g.lastY) / dt;
    g.lastX = e.clientX; g.lastY = e.clientY; g.lastT = e.timeStamp;
    move?.(dx, dy, g);
  });
  const finish = (e, cancelled) => {
    if (!g || e.pointerId !== g.id) return;
    const s = g; g = null;
    if (!s.locked) return;
    swallowNextClick();
    end?.({ dx: e.clientX - s.x0, dy: e.clientY - s.y0, vx: s.vx, vy: s.vy, axis: s.locked, cancelled });
  };
  el.addEventListener('pointerup', (e) => finish(e, false));
  el.addEventListener('pointercancel', (e) => finish(e, true));
}

const EASE = 'cubic-bezier(.22,.8,.24,1)';
/** Anima un elemento hasta un estilo final y lo deja puesto. */
export function glide(el, to, ms = 240) {
  const cs = getComputedStyle(el);
  const a = el.animate([{ transform: cs.transform === 'none' ? 'translate3d(0,0,0)' : cs.transform, opacity: cs.opacity }, { transform: to.transform, opacity: to.opacity ?? '1' }], { duration: ms, easing: EASE, fill: 'forwards' });
  return a.finished.then(() => { el.style.transform = to.transform; el.style.opacity = to.opacity && to.opacity !== '1' ? to.opacity : ''; a.cancel(); }).catch(() => {});
}
