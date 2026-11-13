import { h, icon, plural } from '../dom.js';
import { get } from '../api.js';
import { cover, albumCard, section, hscroll, emptyState, go } from '../ui.js';
import { playAlbum, playArtist, playEverything } from '../actions.js';

const isStandalone = () => navigator.standalone || matchMedia('(display-mode: standalone)').matches;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

function installBanner() {
  let dismissed = false;
  try { dismissed = localStorage.getItem('ebs_install_hint') === '1'; } catch { /* nada */ }
  if (isStandalone() || !isIOS() || dismissed) return null;
  const el = h('div', { class: 'install-banner' }, icon('share'),
    h('div', { style: { flex: '1' } }, h('b', null, 'Instala la app en tu iPhone'),
      h('p', null, 'Toca el botón Compartir de Safari y elige “Agregar a pantalla de inicio”. Así suena también con la pantalla bloqueada.')),
    h('button', { class: 'icon-btn', 'aria-label': 'Ocultar aviso', onclick: () => { try { localStorage.setItem('ebs_install_hint', '1'); } catch { /* nada */ } el.remove(); } }, icon('close')));
  return el;
}

function mixCard(label, sub, albumLike, onclick) {
  const c = cover(albumLike, 'm');
  c.append(h('div', { class: 'mixlabel' }, 'MIX'));
  return h('button', { class: 'card', onclick }, c, h('div', { class: 't' }, label), h('div', { class: 's' }, sub));
}

export default async function home(ctx) {
  const [data, { artists }] = await Promise.all([get('/api/home'), get('/api/artists')]);
  const root = h('div', null, installBanner());
  root.append(h('h1', { class: 'h1' }, 'Tu música. Tu refugio.'));

  if (!data.featured) {
    root.append(emptyState('note', 'Todavía no hay música', ctx.me.isAdmin
      ? 'Copia tus canciones a la carpeta del servidor y toca “Buscar música nueva” en Administración.'
      : 'Muy pronto habrá música aquí.',
    ctx.me.isAdmin ? h('a', { class: 'btn btn-primary btn-sm', href: '#/admin' }, 'Ir a Administración') : null));
    return root;
  }

  const f = data.featured;
  root.append(h('div', { class: 'hero' },
    h('div', { class: 'txt' },
      h('div', null, h('div', { class: 'eyebrow' }, 'Destacado'), h('h2', null, f.title), h('div', { class: 'muted small' }, `${f.artistName} · ${plural(f.trackCount, 'canción', 'canciones')}`)),
      h('button', { class: 'btn btn-primary', onclick: () => playAlbum(f.id) }, icon('play'), 'Reproducir')),
    h('a', { class: 'art', href: `#/album/${f.id}`, 'aria-label': `Ver ${f.title}` }, cover(f, 'm'))));

  if (data.continue.length) root.append(section('Continuar escuchando', hscroll(...data.continue.map(albumCard))));
  root.append(section('Novedades', hscroll(...data.latest.map(albumCard)), { href: '#/lista/album', text: 'Ver todo' }));

  const mixes = [mixCard('Mezcla Búnker', `${data.counts.tracks} canciones`, { albumId: 0, hasCover: false }, playEverything)];
  for (const a of artists.slice(0, 6)) mixes.push(mixCard(`Mix ${a.name}`, plural(a.trackCount, 'canción', 'canciones'), { albumId: a.coverAlbumId ?? a.id, hasCover: !!a.coverAlbumId }, () => playArtist(a.id, { shuffle: true })));
  root.append(section('Hecho para ti', hscroll(...mixes)));
  return root;
}
