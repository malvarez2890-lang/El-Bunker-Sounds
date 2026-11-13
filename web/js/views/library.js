import { h, icon, plural } from '../dom.js';
import { get, del, patch, errorText } from '../api.js';
import { cover, trackRow, backBar, albumCard, section, hscroll, emptyState, createPlaylist, openSheet, promptText, confirmDialog, toast, go } from '../ui.js';
import * as player from '../player.js';
import { playPlaylist } from '../actions.js';

export async function library() {
  const [{ tracks: favs }, { playlists }] = await Promise.all([get('/api/favorites'), get('/api/playlists')]);
  const card = (href, color, ico, title, sub) => h('a', { class: 'libcard', href }, h('div', { class: 'ico', style: { '--c': color } }, icon(ico)),
    h('div', { class: 'main' }, h('div', { class: 't' }, title), h('div', { class: 'muted small' }, sub)), h('span', { class: 'chev' }, icon('right')));
  const root = h('div', null, h('h1', { class: 'h1' }, 'Mi biblioteca'), h('div', { class: 'muted small', style: { 'margin-top': '-8px', 'margin-bottom': '16px' } }, 'Tu colección, siempre a mano.'),
    card('#/favoritos', '#7a3040', 'heartFill', 'Favoritos', plural(favs.length, 'canción', 'canciones')),
    card('#/recientes', '#3a3a66', 'clock', 'Recientes', 'Últimas reproducciones'),
    card('#/playlists', '#6b5230', 'listAdd', 'Mis playlists', plural(playlists.length, 'lista', 'listas')),
    card('#/lista/artistas', '#2c4a3f', 'user', 'Artistas', 'Todos los artistas'),
    card('#/lista/album', '#3b3550', 'disc', 'Álbumes', 'Álbumes, EPs y sencillos'));
  // Álbumes de las últimas canciones guardadas como favoritas.
  const seen = new Map();
  for (const t of favs) if (!seen.has(t.albumId)) seen.set(t.albumId, { id: t.albumId, title: t.albumTitle, artistName: t.artistName, kind: t.kind, hasCover: t.hasCover, coverV: t.coverV });
  if (seen.size) root.append(section('Guardado recientemente', hscroll(...[...seen.values()].slice(0, 10).map(albumCard))));
  return root;
}

/** Pantalla de lista de canciones con botones de reproducir (Favoritos, Recientes, Playlist). */
function trackListScreen({ title, subtitle, tracks, empty, playlistId, reload, extra }) {
  const ready = tracks.filter((t) => t.ready).length;
  const root = h('div', null, backBar(), h('div', { class: 'sub-title' }, h('h1', { class: 'h1' }, title), extra || null));
  if (subtitle) root.append(h('div', { class: 'muted small', style: { 'margin-top': '-8px', 'margin-bottom': '12px' } }, subtitle));
  if (!tracks.length) { root.append(empty); return root; }
  root.append(h('div', { class: 'actions', style: { 'justify-content': 'flex-start' } },
    h('button', { class: 'btn btn-primary', disabled: !ready, onclick: () => player.playTracks(tracks, 0, { shuffle: false }) }, icon('play'), 'Reproducir'),
    h('button', { class: 'btn btn-secondary', disabled: !ready, onclick: () => player.playTracks(tracks, 0, { shuffle: true }) }, icon('shuffle'), 'Aleatorio')));
  root.append(h('div', { class: 'tracklist' }, ...tracks.map((t, i) => trackRow(t, { list: tracks, index: i, showCover: true, playlistId, onChange: reload }))));
  return root;
}

export async function favorites(ctx) {
  const { tracks } = await get('/api/favorites');
  return trackListScreen({ title: 'Favoritos', subtitle: plural(tracks.length, 'canción', 'canciones'), tracks, reload: () => ctx.refresh(),
    empty: emptyState('heart', 'Aún no tienes favoritos', 'Toca el corazón en cualquier canción para guardarla aquí.') });
}
export async function recents(ctx) {
  const { tracks } = await get('/api/recents');
  return trackListScreen({ title: 'Recientes', subtitle: 'Lo último que escuchaste', tracks, reload: () => ctx.refresh(),
    empty: emptyState('clock', 'Todavía no has escuchado nada', 'Cuando reproduzcas música, aparecerá aquí.') });
}

function mosaic(covers) {
  if (!covers.length) return h('div', { class: 'mosaic one' }, h('div', { class: 'ph-all' }, icon('note')));
  const items = covers.slice(0, 4);
  if (items.length < 4) return h('div', { class: 'mosaic one' }, cover({ albumId: items[0], hasCover: true }, 's'));
  return h('div', { class: 'mosaic' }, ...items.map((id) => cover({ albumId: id, hasCover: true }, 's')));
}

export async function playlists(ctx) {
  const { playlists: lists } = await get('/api/playlists');
  const root = h('div', null, backBar(), h('h1', { class: 'h1' }, 'Playlists'),
    h('button', { class: 'btn btn-primary btn-block', style: { 'margin-bottom': '10px' }, onclick: async () => { const pl = await createPlaylist(); if (pl) go(`#/playlist/${pl.id}`); } }, icon('plus'), 'Nueva playlist'));
  if (!lists.length) { root.append(emptyState('listAdd', 'Crea tu primera playlist', 'Junta tus canciones favoritas en listas a tu gusto.')); return root; }
  root.append(...lists.map((pl) => h('div', { class: 'pl-row' },
    h('a', { href: `#/playlist/${pl.id}`, style: { display: 'flex', 'align-items': 'center', gap: '12px', flex: '1', 'min-width': '0' } },
      mosaic(pl.covers), h('div', { class: 'main' }, h('div', { class: 't' }, pl.name), h('div', { class: 's' }, plural(pl.trackCount, 'canción', 'canciones')))),
    h('button', { class: 'icon-btn on', 'aria-label': `Reproducir ${pl.name}`, disabled: !pl.trackCount, onclick: () => playPlaylist(pl.id) }, icon('play')))));
  return root;
}

export async function playlist(ctx, id) {
  const pl = await get(`/api/playlists/${id}`);
  const menu = h('button', { class: 'icon-btn', 'aria-label': 'Opciones de la playlist', onclick: () => openSheet((box, o) => {
    box.append(h('h3', null, pl.name), h('div', { class: 'body' },
      h('button', { class: 'menu-item', onclick: async () => {
        o.close();
        const name = await promptText({ title: 'Cambiar nombre', value: pl.name, confirm: 'Guardar' });
        if (!name) return;
        try { await patch(`/api/playlists/${id}`, { name }); ctx.refresh(); } catch (e) { toast(errorText(e)); }
      } }, icon('edit'), 'Cambiar nombre'),
      h('button', { class: 'menu-item danger', onclick: async () => {
        o.close();
        if (!await confirmDialog({ title: '¿Eliminar esta playlist?', text: 'Las canciones no se borran, solo la lista.', confirm: 'Eliminar', danger: true })) return;
        try { await del(`/api/playlists/${id}`); toast('Playlist eliminada'); go('#/playlists'); } catch (e) { toast(errorText(e)); }
      } }, icon('trash'), 'Eliminar playlist')));
  }) }, icon('more'));
  return trackListScreen({ title: pl.name, subtitle: plural(pl.tracks.length, 'canción', 'canciones'), tracks: pl.tracks, playlistId: id, reload: () => ctx.refresh(), extra: menu,
    empty: emptyState('listAdd', 'Esta playlist está vacía', 'Toca “⋯” en una canción y elige “Agregar a una playlist”.') });
}
