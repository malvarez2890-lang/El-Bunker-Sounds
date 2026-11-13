// Componentes compartidos: carátulas, filas de canciones, hojas inferiores, ventanas y avisos.
import { h, icon, fmtTime, clear, add, plural, KIND_LABEL } from './dom.js';
import { get, post, put, del, coverUrl, errorText } from './api.js';
import * as player from './player.js';
import { navBack } from './router.js';
import { pointerGesture, glide } from './gestures.js';

/** Todo lo que se abre encima (hojas, ventanas, avisos, reproductor) va dentro de #rot, para que rote junto con la app. */
export const overlayRoot = () => document.getElementById('rot') || document.body;

const GRADS = [['#ec4899', '#28103c'], ['#ffa028', '#32140a'], ['#3cbec8', '#081e32'], ['#825aff', '#140a37'], ['#f05a3c', '#320a0f']];

/** Carátula (o un degradado con nota musical si el álbum no tiene imagen). */
export function cover(item, variant = 'm', cls = '') {
  const albumId = item.albumId ?? item.id;
  const el = h('div', { class: `cover ${cls}`.trim() });
  const [a, b] = GRADS[Math.abs(albumId || 0) % GRADS.length];
  el.style.setProperty('background', `linear-gradient(145deg, ${a}, ${b})`);
  const ph = () => h('div', { class: 'ph' }, icon('note'));
  if (item.hasCover) {
    const img = h('img', { src: coverUrl(albumId, variant, item.coverV), alt: '', loading: 'lazy', decoding: 'async', draggable: false });
    img.addEventListener('error', () => { img.remove(); el.append(ph()); });
    el.append(img);
  } else el.append(ph());
  return el;
}

export const go = (hash) => { location.hash = hash; };

// ---------- avisos ----------
export function toast(text) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = h('div', { class: 'toast', role: 'status' }, text);
  overlayRoot().append(el);
  setTimeout(() => el.remove(), 2700);
}

// ---------- estados ----------
export function emptyState(ico, title, text, action) {
  return h('div', { class: 'state' }, h('div', { class: 'big' }, icon(ico)), h('h3', null, title), text && h('div', null, text), action);
}
export function loadingState(kind = 'list') {
  if (kind === 'grid') return h('div', { class: 'grid' }, ...Array.from({ length: 6 }, () => h('div', { class: 'skel', style: { 'aspect-ratio': '1' } })));
  return h('div', null, ...Array.from({ length: 7 }, () => h('div', { class: 'skel', style: { height: '54px', 'margin-bottom': '10px' } })));
}
export function errorState(err, retry) {
  return h('div', { class: 'state' }, h('div', { class: 'big' }, icon('wave')), h('h3', null, 'No pudimos cargar esto'), h('div', null, errorText(err)),
    retry && h('button', { class: 'btn btn-secondary btn-sm', onclick: retry }, icon('refresh'), 'Reintentar'));
}

// ---------- hojas y ventanas ----------
function overlay(build, { modal = false } = {}) {
  const prevFocus = document.activeElement;
  const backdrop = h('div', { class: 'sheet-backdrop' });
  const box = h('div', { class: modal ? 'modal' : 'sheet', role: 'dialog', 'aria-modal': 'true' });
  if (!modal) box.append(h('div', { class: 'grab' }));
  let closed = false;
  const api = {
    close(result) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove(); box.remove();
      prevFocus?.focus?.();
      api.onClose?.(result);
    },
  };
  const onKey = (e) => { if (e.key === 'Escape') api.close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', () => api.close());
  build(box, api);
  overlayRoot().append(backdrop, box);
  if (!modal) {
    // Deslizar hacia abajo desde la barrita o el encabezado cierra la hoja.
    pointerGesture(box, {
      filter: (e) => !!e.target.closest('.grab, h3, .menu-head'),
      lock: (axis, dx, dy) => axis === 'y' && dy > 0,
      move: (dx, dy) => { box.style.transform = `translate(-50%, ${Math.max(0, dy)}px)`; },
      end({ dy, vy, cancelled }) {
        if (!cancelled && (dy > 90 || vy > 0.6)) { glide(box, { transform: 'translate(-50%, 100%)' }, 180).then(() => api.close()); backdrop.style.transition = 'opacity .18s'; backdrop.style.opacity = '0'; }
        else glide(box, { transform: 'translate(-50%, 0)' }, 180).then(() => { box.style.transform = ''; });
      },
    });
  }
  return api;
}
export const openSheet = (build) => overlay(build);

export function promptText({ title, label = '', value = '', confirm = 'Guardar', maxLength = 60 }) {
  return new Promise((resolve) => {
    const o = overlay((box, o) => {
      const input = h('input', { class: 'field', value, maxLength, 'aria-label': label || title, autocomplete: 'off', enterKeyHint: 'done' });
      const ok = () => { const v = input.value.trim(); if (v) o.close(v); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      box.append(h('h3', null, title), input,
        h('div', { class: 'btns' }, h('button', { class: 'btn btn-ghost', onclick: () => o.close(null) }, 'Cancelar'), h('button', { class: 'btn btn-primary', onclick: ok }, confirm)));
      setTimeout(() => { input.focus(); input.select(); }, 60);
    }, { modal: true });
    o.onClose = (v) => resolve(v ?? null);
  });
}

export function confirmDialog({ title, text, confirm = 'Aceptar', danger = false }) {
  return new Promise((resolve) => {
    const o = overlay((box, o) => {
      add(box, h('h3', null, title), text && h('div', { class: 'muted' }, text),
        h('div', { class: 'btns' }, h('button', { class: 'btn btn-ghost', onclick: () => o.close(false) }, 'Cancelar'),
          h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => o.close(true) }, confirm)));
    }, { modal: true });
    o.onClose = (v) => resolve(!!v);
  });
}

export function lightbox(src, title) {
  overlay((box, o) => {
    box.classList.add('lightbox');
    box.append(h('h3', null, title), h('img', { src, alt: title }), h('div', { class: 'btns' }, h('button', { class: 'btn btn-secondary', onclick: () => o.close() }, 'Cerrar')));
  }, { modal: true });
}

// ---------- favoritos y listas ----------
export async function toggleFav(track, onDone) {
  const want = !track.fav;
  try {
    await (want ? put(`/api/favorites/${track.id}`) : del(`/api/favorites/${track.id}`));
    track.fav = want;
    player.setFav(track.id, want);
    toast(want ? 'Agregada a tus favoritos' : 'Quitada de tus favoritos');
    onDone?.(want);
  } catch (e) { toast(errorText(e)); }
}

export async function createPlaylist() {
  const name = await promptText({ title: 'Nueva playlist', label: 'Nombre de la playlist', confirm: 'Crear' });
  if (!name) return null;
  try { return await post('/api/playlists', { name }); } catch (e) { toast(errorText(e)); return null; }
}

export async function pickPlaylist(trackIds) {
  let lists;
  try { ({ playlists: lists } = await get('/api/playlists')); } catch (e) { toast(errorText(e)); return; }
  openSheet((box, o) => {
    const add = async (pl) => {
      try {
        const r = await post(`/api/playlists/${pl.id}/tracks`, { trackIds });
        o.close();
        toast(r.added ? `Agregada a “${pl.name}”` : `Ya estaba en “${pl.name}”`);
      } catch (e) { toast(errorText(e)); }
    };
    box.append(h('h3', null, 'Agregar a una playlist'),
      h('div', { class: 'body' },
        h('button', { class: 'menu-item', onclick: async () => { const pl = await createPlaylist(); if (pl) add(pl); } }, icon('plus'), 'Nueva playlist'),
        ...lists.map((pl) => h('button', { class: 'menu-item', onclick: () => add(pl) }, icon('listAdd'), h('span', null, pl.name, ' ', h('span', { class: 'muted small' }, `· ${plural(pl.trackCount, 'canción', 'canciones')}`))))));
  });
}

export function openTrackMenu(track, { playlistId, onChange } = {}) {
  openSheet((box, o) => {
    const item = (ico, label, fn, cls = '') => h('button', { class: `menu-item ${cls}`.trim(), onclick: () => { o.close(); fn(); } }, icon(ico), label);
    box.append(
      h('div', { class: 'menu-head' }, cover(track, 's'),
        h('div', { style: { 'min-width': '0' } }, h('div', { class: 'h2', style: { 'font-size': '16px' } }, track.title), h('div', { class: 'muted small' }, `${track.artistName} · ${track.albumTitle}`))),
      h('div', { class: 'body' },
        item(track.fav ? 'heartFill' : 'heart', track.fav ? 'Quitar de favoritos' : 'Agregar a favoritos', () => toggleFav(track, onChange)),
        item('nextUp', 'Reproducir a continuación', () => { player.playNext(track); toast('Sonará a continuación'); }),
        item('queue', 'Agregar a la cola', () => { player.addToQueue(track); toast('Agregada a la cola'); }),
        item('listAdd', 'Agregar a una playlist', () => pickPlaylist([track.id])),
        item('disc', 'Ir al álbum', () => go(`#/album/${track.albumId}`)),
        item('user', 'Ir al artista', () => go(`#/artista/${track.artistId}`)),
        playlistId && item('trash', 'Quitar de esta playlist', async () => {
          try { await del(`/api/playlists/${playlistId}/tracks/${track.id}`); toast('Quitada de la playlist'); onChange?.('removed'); } catch (e) { toast(errorText(e)); }
        }, 'danger')));
  });
}

// ---------- filas y tarjetas ----------
/** Fila de canción. Al tocarla suena la lista completa desde esa canción. */
export function trackRow(track, { list, index, number, showCover = false, playlistId, onChange } = {}) {
  const cur = player.current();
  const isCur = cur?.id === track.id;
  const lead = showCover ? cover(track, 's')
    : h('span', { class: 'num' }, h('span', { class: 'n' }, number ?? ''), h('span', { class: 'eq', hidden: true }, h('i'), h('i'), h('i')));
  const play = () => {
    if (track.ready === false) { toast('Esta canción se está preparando. Intenta en un momento.'); return; }
    player.playTracks(list || [track], list ? index : 0);
  };
  const row = h('div', { class: `row tap${track.ready === false ? ' unready' : ''}`, dataset: { tid: String(track.id) } },
    lead,
    h('button', { class: 'main', 'aria-label': `Reproducir ${track.title}`, onclick: (e) => { e.stopPropagation(); play(); } },
      h('div', { class: 't' }, track.title), h('div', { class: 's' }, track.ready === false ? 'Preparando audio…' : (showCover ? `${track.artistName} · ${track.albumTitle}` : track.artistName))),
    track.duration ? h('span', { class: 'dur' }, fmtTime(track.duration)) : null,
    h('button', { class: 'icon-btn', 'aria-label': `Más opciones de ${track.title}`, onclick: (e) => { e.stopPropagation(); openTrackMenu(track, { playlistId, onChange }); } }, icon('more')));
  row.addEventListener('click', play); // tocar el número, la carátula o la duración también reproduce
  markRow(row, cur, player.state().playing);
  return row;
}

function markRow(row, cur, playing) {
  const isCur = cur && String(cur.id) === row.dataset.tid;
  row.classList.toggle('current', !!isCur);
  row.classList.toggle('playing', !!(isCur && playing));
  const eq = row.querySelector('.eq'), n = row.querySelector('.n');
  if (eq) { eq.hidden = !isCur; if (n) n.hidden = !!isCur; }
}
player.on('change', (s) => document.querySelectorAll('.row[data-tid]').forEach((r) => markRow(r, s.queue[s.index], s.playing)));

export function albumCard(album) {
  return h('a', { class: 'card', href: `#/album/${album.id}` }, cover(album, 'm'),
    h('div', { class: 't' }, album.title), h('div', { class: 's' }, `${album.artistName} · ${KIND_LABEL[album.kind] || 'Álbum'}`));
}
export function artistCard(artist) {
  return h('a', { class: 'card', href: `#/artista/${artist.id}` }, cover({ albumId: artist.coverAlbumId ?? artist.id, hasCover: !!artist.coverAlbumId }, 'm', 'round'),
    h('div', { class: 't', style: { 'text-align': 'center' } }, artist.name), artist.albumCount != null && h('div', { class: 's', style: { 'text-align': 'center' } }, plural(artist.albumCount, 'álbum', 'álbumes')));
}
export function section(title, body, link) {
  return h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { class: 'h2' }, title), link && h('a', { href: link.href }, link.text)), body);
}
export const hscroll = (...kids) => h('div', { class: 'hscroll' }, ...kids);
export function backBar(title) {
  return h('div', { class: 'backbar' },
    h('button', { class: 'icon-btn', 'aria-label': 'Volver', onclick: navBack }, icon('left')),
    title && h('div', { class: 'h2' }, title));
}
export { clear };
