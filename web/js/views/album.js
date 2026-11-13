import { h, icon, fmtMinutes, plural, KIND_LABEL } from '../dom.js';
import { get, coverUrl } from '../api.js';
import { cover, trackRow, backBar, albumCard, section, lightbox, emptyState } from '../ui.js';
import * as player from '../player.js';

export async function album(ctx, id) {
  const a = await get(`/api/albums/${id}`);
  const root = h('div', null, backBar());
  const ready = a.tracks.filter((t) => t.ready).length;
  const actions = h('div', { class: 'actions' },
    h('button', { class: 'btn btn-primary', disabled: !ready, onclick: () => player.playTracks(a.tracks, 0, { shuffle: false }) }, icon('play'), 'Reproducir'),
    h('button', { class: 'icon-btn ring', disabled: !ready, 'aria-label': 'Reproducir en orden aleatorio', onclick: () => player.playTracks(a.tracks, 0, { shuffle: true }) }, icon('shuffle')),
    a.hasBack ? h('button', { class: 'icon-btn ring', 'aria-label': 'Ver contraportada', onclick: () => lightbox(coverUrl(a.id, 'back', a.backV), `Contraportada · ${a.title}`) }, icon('photo')) : null);
  root.append(h('div', { class: 'detail-head' }, cover(a, 'l'), h('h1', null, a.title),
    h('div', { class: 'meta' }, h('a', { href: `#/artista/${a.artistId}` }, a.artistName), ` · ${KIND_LABEL[a.kind]} · ${plural(a.trackCount, 'canción', 'canciones')} · ${fmtMinutes(a.duration)}`),
    actions));
  if (ready < a.tracks.length) root.append(h('div', { class: 'muted small', style: { 'margin-bottom': '8px', 'text-align': 'center' } }, `Preparando audio: ${a.tracks.length - ready} canciones en proceso…`));
  root.append(h('div', { class: 'tracklist' }, ...a.tracks.map((t, i) => trackRow(t, { list: a.tracks, index: i, number: t.trackNo ?? i + 1 }))));
  return root;
}

export async function artist(ctx, id) {
  const a = await get(`/api/artists/${id}`);
  const root = h('div', null, backBar());
  const lead = a.albums.find((x) => x.hasCover) || { id: a.id, hasCover: false };
  root.append(h('div', { class: 'detail-head artist-head' }, cover({ albumId: lead.id, hasCover: lead.hasCover, coverV: lead.coverV }, 'm', 'round'), h('h1', { style: { 'text-transform': 'none' } }, a.name),
    h('div', { class: 'meta' }, `${plural(a.albums.length, 'lanzamiento', 'lanzamientos')} · ${plural(a.trackCount, 'canción', 'canciones')}`),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-primary', onclick: () => player.playTracks(a.tracks, 0, { shuffle: false }) }, icon('play'), 'Reproducir'),
      h('button', { class: 'icon-btn ring', 'aria-label': 'Reproducir en orden aleatorio', onclick: () => player.playTracks(a.tracks, 0, { shuffle: true }) }, icon('shuffle')))));
  if (!a.albums.length) { root.append(emptyState('disc', 'Sin lanzamientos')); return root; }
  root.append(section('Discografía', h('div', { class: 'grid' }, ...a.albums.map(albumCard))));
  const top = a.tracks.slice(0, 8);
  root.append(section('Canciones', h('div', { class: 'tracklist' }, ...top.map((t, i) => trackRow(t, { list: a.tracks, index: i, showCover: true })))));
  return root;
}
