import { h, icon, plural } from '../dom.js';
import { get } from '../api.js';
import { albumCard, artistCard, section, hscroll, backBar, emptyState } from '../ui.js';

const TILES = [
  ['album', 'Álbumes', '#5a2a3f'],
  ['ep', 'EPs', '#2a3f5a'],
  ['single', 'Sencillos', '#3f3a1f'],
  ['artistas', 'Artistas', '#2c4a3f'],
];

export async function explore() {
  const [{ albums }, { artists }] = await Promise.all([get('/api/albums'), get('/api/artists')]);
  const count = { album: 0, ep: 0, single: 0, artistas: artists.length };
  albums.forEach((a) => { count[a.kind]++; });
  const root = h('div', null, h('h1', { class: 'h1' }, 'Explorar'),
    h('a', { class: 'searchlink', href: '#/buscar' }, icon('search'), 'Artistas, álbumes, canciones…'));
  if (!albums.length) { root.append(emptyState('compass', 'Nada para explorar todavía', 'Cuando haya música, la verás aquí.')); return root; }
  root.append(h('div', { class: 'tiles' }, ...TILES.filter(([k]) => count[k]).map(([k, label, color]) =>
    h('a', { class: 'tile', href: `#/lista/${k}`, style: { '--tile': color } }, h('b', null, label), h('span', null, String(count[k]))))));
  root.append(section('Novedades', hscroll(...albums.slice(0, 12).map(albumCard))));
  root.append(section('Artistas', hscroll(...artists.map(artistCard))));
  return root;
}

const TITLES = { album: 'Álbumes', ep: 'EPs', single: 'Sencillos', artistas: 'Artistas' };
export async function lista(ctx, kind) {
  const root = h('div', null, backBar(), h('h1', { class: 'h1' }, TITLES[kind]));
  if (kind === 'artistas') {
    const { artists } = await get('/api/artists');
    root.append(h('div', { class: 'grid' }, ...artists.map(artistCard)));
  } else {
    const { albums } = await get(`/api/albums?kind=${kind}`);
    root.append(albums.length ? h('div', { class: 'grid' }, ...albums.map(albumCard)) : emptyState('disc', 'Aquí no hay nada todavía'));
  }
  return root;
}
