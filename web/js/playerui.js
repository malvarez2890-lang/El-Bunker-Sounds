// Mini reproductor (siempre visible) y reproductor expandido.
import { h, icon, fmtTime, clear } from './dom.js';
import * as player from './player.js';
import { cover, toggleFav, go, openSheet, toast, overlayRoot } from './ui.js';
import { pointerGesture, glide } from './gestures.js';
import { onkyoAvailable, openOnkyo } from './onkyoui.js';

let miniEl = null;

export function mountMini(parent) {
  miniEl = h('div', { class: 'mini', hidden: true, role: 'group', 'aria-label': 'Reproductor' });
  parent.append(miniEl);
  const render = () => {
    const s = player.state();
    const t = player.current();
    document.body.classList.toggle('has-mini', !!t);
    miniEl.hidden = !t;
    if (!t) return;
    const prevId = miniEl.dataset.tid;
    if (prevId !== String(t.id)) {
      miniEl.dataset.tid = String(t.id);
      clear(miniEl);
      miniEl.append(
        cover(t, 's'),
        h('div', { class: 'main' }, h('div', { class: 't' }, t.title), h('div', { class: 's' }, t.artistName)),
        h('button', { class: 'icon-btn', 'aria-label': 'Reproducir o pausar', id: 'mini-toggle', onclick: (e) => { e.stopPropagation(); player.toggle(); } }),
        h('button', { class: 'icon-btn', 'aria-label': 'Siguiente', onclick: (e) => { e.stopPropagation(); player.next(); } }, icon('next')),
        h('div', { class: 'bar' }));
    }
    const btn = miniEl.querySelector('#mini-toggle');
    const pl = player.isPlayingUI(s);
    clear(btn).append(icon(pl ? 'pause' : 'play'));
    btn.setAttribute('aria-label', pl ? 'Pausar' : 'Reproducir');
    btn.classList.toggle('loading', !!s.loading);
    updateBar();
  };
  const updateBar = () => {
    const d = player.duration();
    miniEl.style.setProperty('--p', d ? Math.min(1, player.position() / d).toFixed(4) : '0');
  };
  miniEl.addEventListener('click', () => openPlayer());
  pointerGesture(miniEl, {
    lock: (axis, dx, dy) => axis === 'x' || (axis === 'y' && dy < 0),
    move: (dx, dy, g) => { if (g.locked === 'x') { miniEl.style.transform = `translate3d(${dx * 0.7}px,0,0)`; miniEl.style.opacity = String(1 - Math.min(0.5, Math.abs(dx) / 500)); } },
    async end({ dx, dy, vx, axis, cancelled }) {
      if (axis === 'y') { if (!cancelled && dy < -30) openPlayer(); return; }
      const go = !cancelled && (Math.abs(dx) > 70 || Math.abs(vx) > 0.5);
      if (go) {
        const dir = dx < 0 ? -1 : 1;
        await glide(miniEl, { transform: `translate3d(${dir * 140}px,0,0)`, opacity: '0' }, 130);
        miniEl.style.transition = 'none';
        miniEl.style.transform = `translate3d(${-dir * 90}px,0,0)`;
        if (dx < 0) player.next(); else player.prev();
        await glide(miniEl, { transform: 'translate3d(0,0,0)', opacity: '1' }, 170);
        miniEl.style.transition = '';
      } else await glide(miniEl, { transform: 'translate3d(0,0,0)', opacity: '1' }, 160);
      miniEl.style.transform = ''; miniEl.style.opacity = '';
    },
  });
  player.on('change', render);
  player.on('time', updateBar);
  render();
}

export function openPlayer() {
  if (!player.current() || document.querySelector('.player')) return;
  const root = h('div', { class: 'player', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Reproductor' });
  const inner = h('div', { class: 'inner' });
  root.append(inner);
  overlayRoot().append(root);
  document.body.style.setProperty('overflow', 'hidden');
  let enterFrom = 0; // de qué lado entra la carátula nueva tras deslizar

  let dragging = false;
  let shownId = null;
  const els = {};

  let closed = false;
  const close = async ({ fromDrag = false } = {}) => {
    if (closed) return;
    closed = true;
    unsub(); unsubTime();
    document.removeEventListener('keydown', onKey);
    document.body.style.removeProperty('overflow');
    if (fromDrag) { await glide(root, { transform: 'translate3d(0,100%,0)' }, 200); root.remove(); return; }
    root.classList.add('closing');
    setTimeout(() => root.remove(), 220);
  };
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.sheet')) close(); };
  document.addEventListener('keydown', onKey);

  function build(t) {
    clear(inner);
    els.range = h('input', { class: 'range', type: 'range', min: 0, max: 1000, value: 0, step: 1, 'aria-label': 'Posición de la canción' });
    els.cur = h('span', null, '0:00');
    els.dur = h('span', null, '0:00');
    els.play = h('button', { class: 'play', 'aria-label': 'Reproducir o pausar', onclick: () => player.toggle() });
    els.shuffle = h('button', { class: 'icon-btn sm', 'aria-label': 'Aleatorio', onclick: () => player.toggleShuffle() }, icon('shuffle'));
    els.repeat = h('button', { class: 'icon-btn sm', 'aria-label': 'Repetir', onclick: () => player.cycleRepeat() });
    els.fav = h('button', { class: 'icon-btn', onclick: () => toggleFav(t, () => paint()) });
    els.range.addEventListener('input', () => { dragging = true; els.cur.textContent = fmtTime((els.range.value / 1000) * player.duration()); els.range.style.setProperty('--p', els.range.value / 1000); });
    els.range.addEventListener('change', () => { player.seek((els.range.value / 1000) * player.duration()); dragging = false; });

    inner.append(
      h('div', { class: 'glow' }),
      h('div', { class: 'top' },
        h('button', { class: 'icon-btn', 'aria-label': 'Cerrar reproductor', onclick: close }, icon('down')),
        els.eyebrow = h('div', { class: 'eyebrow' }, 'Reproduciendo'),
        h('span', { style: { width: '44px' } })),
      h('div', { class: 'art' }, cover(t, 'l')),
      h('div', { class: 'info' },
        h('div', { class: 'txt' }, h('h2', null, t.title),
          h('a', { class: 'artist', href: `#/artista/${t.artistId}`, onclick: close }, t.artistName)),
        els.fav),
      h('div', { class: 'seek' }, els.range, h('div', { class: 'times' }, els.cur, els.dur)),
      h('div', { class: 'controls' }, els.shuffle,
        h('button', { class: 'icon-btn', 'aria-label': 'Anterior', onclick: () => player.prev() }, icon('prev')), els.play,
        h('button', { class: 'icon-btn', 'aria-label': 'Siguiente', onclick: () => player.next() }, icon('next')), els.repeat),
      h('div', { class: 'bottom' },
        h('button', { class: 'chip', onclick: openQueue }, icon('queue'), 'En cola'),
        h('a', { class: 'chip', href: `#/album/${t.albumId}`, onclick: close }, icon('disc'), 'Ver álbum'),
        onkyoAvailable() ? h('button', { class: 'chip', onclick: openOnkyo }, icon('speaker'), 'Onkyo') : null));
    if (enterFrom) { // la carátula nueva entra deslizando desde el lado contrario
      const art = inner.querySelector('.art .cover');
      art.animate([{ transform: `translate3d(${enterFrom * 60}%,0,0)`, opacity: 0 }, { transform: 'translate3d(0,0,0)', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.22,.8,.24,1)' });
      enterFrom = 0;
    }
  }

  function paint() {
    const s = player.state();
    const t = player.current();
    if (!t) { close(); return; }
    if (shownId !== t.id) { shownId = t.id; build(t); }
    const pl = player.isPlayingUI(s);
    els.eyebrow.textContent = player.isRemote() ? 'Sonando en el Onkyo' : 'Reproduciendo';
    clear(els.play).append(icon(pl ? 'pause' : 'play'));
    els.play.setAttribute('aria-label', pl ? 'Pausar' : 'Reproducir');
    els.play.classList.toggle('loading', !!s.loading);
    els.shuffle.classList.toggle('on', s.shuffle);
    els.shuffle.setAttribute('aria-pressed', String(s.shuffle));
    clear(els.repeat).append(icon(s.repeat === 'one' ? 'repeat1' : 'repeat'));
    els.repeat.classList.toggle('on', s.repeat !== 'off');
    els.repeat.setAttribute('aria-label', s.repeat === 'off' ? 'Repetir: apagado' : s.repeat === 'all' ? 'Repetir toda la cola' : 'Repetir esta canción');
    clear(els.fav).append(icon(t.fav ? 'heartFill' : 'heart'));
    els.fav.classList.toggle('on', !!t.fav);
    els.fav.setAttribute('aria-label', t.fav ? 'Quitar de favoritos' : 'Agregar a favoritos');
    tick();
  }
  function tick() {
    if (!els.range) return;
    const d = player.duration();
    els.dur.textContent = fmtTime(d);
    if (dragging) return;
    els.cur.textContent = fmtTime(player.position());
    const p = d ? Math.min(1, player.position() / d) : 0;
    els.range.value = Math.round(p * 1000);
    els.range.style.setProperty('--p', p);
  }
  // Deslizar hacia abajo cierra la tarjeta; deslizar la carátula a los lados cambia de canción.
  pointerGesture(root, {
    filter: (e) => !!e.target.closest('.top, .art, .info') && !e.target.closest('.range'),
    lock: (axis, dx, dy, g) => (axis === 'y' ? dy > 0 : !!g.target.closest('.art')),
    move: (dx, dy, g) => {
      if (g.locked === 'y') root.style.transform = `translate3d(0,${Math.max(0, dy)}px,0)`;
      else { const art = inner.querySelector('.art .cover'); if (art) { art.style.transform = `translate3d(${dx}px,0,0)`; art.style.opacity = String(1 - Math.min(0.6, Math.abs(dx) / 400)); } }
    },
    async end({ dx, dy, vx, vy, axis, cancelled }) {
      if (axis === 'y') {
        if (!cancelled && (dy > 140 || vy > 0.6)) close({ fromDrag: true });
        else glide(root, { transform: 'translate3d(0,0,0)' }, 200).then(() => { root.style.transform = ''; });
        return;
      }
      const art = inner.querySelector('.art .cover');
      if (!cancelled && (Math.abs(dx) > 90 || Math.abs(vx) > 0.5)) {
        enterFrom = dx < 0 ? 1 : -1; // si se desliza a la izquierda, la nueva entra por la derecha
        if (art) await glide(art, { transform: `translate3d(${dx < 0 ? -120 : 120}px,0,0)`, opacity: '0' }, 120);
        if (dx < 0) player.next(); else player.prev();
      } else if (art) glide(art, { transform: 'translate3d(0,0,0)', opacity: '1' }, 180).then(() => { art.style.transform = ''; art.style.opacity = ''; });
    },
  });
  const unsub = player.on('change', paint);
  const unsubTime = player.on('time', tick);
  paint();
}

export function openQueue() {
  openSheet((box, o) => {
    const s = player.state();
    const list = h('div', { class: 'body' });
    const draw = () => {
      const st = player.state();
      clear(list);
      st.queue.forEach((t, i) => {
        const isCur = i === st.index;
        list.append(h('div', { class: `row${isCur ? ' current' : ''}`, onclick: () => { player.jumpTo(i); } },
          h('span', { class: 'num' }, isCur ? icon('play') : i + 1),
          h('button', { class: 'main', 'aria-label': `Tocar ${t.title}`, onclick: (e) => { e.stopPropagation(); player.jumpTo(i); } }, h('div', { class: 't' }, t.title), h('div', { class: 's' }, t.artistName)),
          isCur ? null : h('button', { class: 'icon-btn', 'aria-label': `Quitar ${t.title} de la cola`, onclick: (e) => { e.stopPropagation(); player.removeFromQueue(i); draw(); } }, icon('close'))));
      });
    };
    draw();
    box.append(h('h3', null, `En cola · ${s.queue.length} ${s.queue.length === 1 ? 'canción' : 'canciones'}`), list);
    const off = player.on('change', draw);
    o.onClose = off;
    setTimeout(() => list.querySelector('.current')?.scrollIntoView({ block: 'center' }), 80);
  });
}
