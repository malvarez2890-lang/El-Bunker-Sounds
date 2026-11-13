import { h, icon, plural, fill } from '../dom.js';
import { get } from '../api.js';
import { cover, albumCard, section, hscroll, emptyState, go } from '../ui.js';
import { playAlbum, playArtist, playEverything } from '../actions.js';

const isStandalone = () => navigator.standalone || matchMedia('(display-mode: standalone)').matches;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isAndroid = () => /android/i.test(navigator.userAgent);

/** Aviso para instalar la app: iPhone (pasos con Compartir) y Android (botón "Instalar" si el navegador lo permite, o pasos del menú). */
function installBanner() {
  let dismissed = false;
  try { dismissed = localStorage.getItem('ebs_install_hint') === '1'; } catch { /* nada */ }
  const ios = isIOS(), android = isAndroid();
  if (isStandalone() || dismissed || (!ios && !android)) return null;
  const el = h('div', { class: 'install-banner' });
  const close = () => { try { localStorage.setItem('ebs_install_hint', '1'); } catch { /* nada */ } el.remove(); };
  const draw = () => {
    const ev = window.__installEvent; // Chrome en Android avisa cuando se puede instalar con un botón
    fill(el, icon(ios ? 'share' : 'plus'),
      h('div', { style: { flex: '1' } },
        h('b', null, ios ? 'Instala la app en tu iPhone' : 'Instala la app en tu celular'),
        h('p', null, ios
          ? 'Toca el botón Compartir de Safari y elige “Agregar a pantalla de inicio”. Así suena también con la pantalla bloqueada.'
          : ev ? 'Queda como una app en tu pantalla de inicio y suena también con la pantalla bloqueada.'
            : 'Toca el menú ⋮ del navegador y elige “Instalar app” o “Agregar a la pantalla de inicio”.'),
        ev ? h('button', { class: 'btn btn-primary btn-sm', style: { 'margin-top': '10px' }, onclick: async () => {
          ev.prompt();
          const choice = await ev.userChoice.catch(() => null);
          window.__installEvent = null;
          if (choice?.outcome === 'accepted') el.remove(); else draw();
        } }, 'Instalar') : null),
      h('button', { class: 'icon-btn', 'aria-label': 'Ocultar aviso', onclick: close }, icon('close')));
  };
  draw();
  window.addEventListener('ebs:installable', () => { if (el.isConnected) draw(); });
  window.addEventListener('ebs:installed', () => el.remove());
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
