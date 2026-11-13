// Mini reproductor (siempre visible) y reproductor expandido.
import { h, icon, fmtTime, clear } from './dom.js';
import * as player from './player.js';
import { cover, toggleFav, go, openSheet, toast } from './ui.js';

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
  player.on('change', render);
  player.on('time', updateBar);
  render();
}

export function openPlayer() {
  if (!player.current() || document.querySelector('.player')) return;
  const root = h('div', { class: 'player', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Reproductor' });
  const inner = h('div', { class: 'inner' });
  root.append(inner);
  document.body.append(root);
  document.body.style.setProperty('overflow', 'hidden');

  let dragging = false;
  let shownId = null;
  const els = {};

  const close = () => {
    unsub(); unsubTime();
    document.removeEventListener('keydown', onKey);
    document.body.style.removeProperty('overflow');
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
        h('div', { class: 'eyebrow' }, 'Reproduciendo'),
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
        h('a', { class: 'chip', href: `#/album/${t.albumId}`, style: { 'margin-left': '10px' }, onclick: close }, icon('disc'), 'Ver álbum')));
  }

  function paint() {
    const s = player.state();
    const t = player.current();
    if (!t) { close(); return; }
    if (shownId !== t.id) { shownId = t.id; build(t); }
    const pl = player.isPlayingUI(s);
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
