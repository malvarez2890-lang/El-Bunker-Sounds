import { h, icon, plural, fill } from '../dom.js';
import { get, errorText } from '../api.js';
import { pushState, enablePush, PUSH_HELP } from '../push.js';
import { cover, albumCard, section, hscroll, emptyState, go, toast } from '../ui.js';
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

const fechaLarga = (iso) => { const [y, m, d] = String(iso || '').split('-').map(Number); return y ? new Date(y, m - 1, d).toLocaleDateString('es-CL', { day: 'numeric', month: 'long' }) : ''; };

/** Tarjeta de novedad (la publica el administrador): título, texto y, si tiene álbum, su portada y un botón para verlo. */
function newsCard(n) {
  const a = n.album;
  const sub = a && a.totalCount > a.trackCount && a.releaseDate ? `Álbum completo el ${fechaLarga(a.releaseDate)}` : null;
  return h('div', { class: `hero news${a ? '' : ' noart'}` },
    h('div', { class: 'txt' },
      h('div', null, h('div', { class: 'eyebrow' }, 'Novedad'), h('h2', null, n.title),
        n.body ? h('p', { class: 'news-body' }, n.body) : null,
        sub ? h('div', { class: 'muted small', style: { 'margin-top': '6px' } }, sub) : null),
      h('div', null, a ? h('a', { class: 'btn btn-primary', href: `#/album/${a.id}` }, icon('disc'), 'Ver álbum') : null, remindButton())),
    a ? h('a', { class: 'art', href: `#/album/${a.id}`, 'aria-label': `Ver ${a.title}` }, cover(a, 'm')) : null);
}

/** Botón "Avísame" (solo si los avisos están apagados y se pueden activar): un toque y listo. */
function remindButton() {
  const slot = h('span');
  pushState().then((ps) => {
    if (ps === 'on' || ps === 'unsupported') return;
    slot.append(h('button', { class: 'btn btn-secondary btn-sm', style: { 'margin-top': '10px' }, onclick: async (e) => {
      if (PUSH_HELP[ps]) { toast(PUSH_HELP[ps]); return; }
      try { const r = await enablePush(); if (r === 'on') { toast('Listo: te avisaremos'); e.target.closest('span')?.remove(); } else toast(PUSH_HELP.denied); } catch (err) { toast(errorText(err)); }
    } }, icon('bell'), 'Avísame'));
  }).catch(() => {});
  return slot;
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
  for (const n of data.news || []) root.append(newsCard(n));
  // Con una novedad arriba, el destacado se achica a una fila; sin novedades sigue grande como siempre.
  if (data.news?.length) {
    root.append(h('div', { class: 'feat-row' }, h('a', { href: `#/album/${f.id}`, 'aria-label': `Ver ${f.title}` }, cover(f, 's')),
      h('div', { class: 'main' }, h('div', { class: 'eyebrow' }, 'Destacado'), h('div', { class: 't' }, f.title), h('div', { class: 's' }, `${f.artistName} · ${plural(f.trackCount, 'canción', 'canciones')}`)),
      h('button', { class: 'icon-btn ring', 'aria-label': `Reproducir ${f.title}`, onclick: () => playAlbum(f.id) }, icon('play'))));
  } else root.append(h('div', { class: 'hero' },
    h('div', { class: 'txt' },
      h('div', null, h('div', { class: 'eyebrow' }, 'Destacado'), h('h2', null, f.title), h('div', { class: 'muted small' }, `${f.artistName} · ${plural(f.trackCount, 'canción', 'canciones')}`)),
      h('button', { class: 'btn btn-primary', onclick: () => playAlbum(f.id) }, icon('play'), 'Reproducir')),
    h('a', { class: 'art', href: `#/album/${f.id}`, 'aria-label': `Ver ${f.title}` }, cover(f, 'm'))));

  if (data.continue.length) root.append(section('Continuar escuchando', hscroll(...data.continue.map(albumCard))));
  root.append(section('Recién agregado', hscroll(...data.latest.map(albumCard)), { href: '#/lista/album', text: 'Ver todo' }));

  const mixes = [mixCard('Mezcla Búnker', `${data.counts.tracks} canciones`, { albumId: 0, hasCover: false }, playEverything)];
  for (const a of artists.slice(0, 6)) mixes.push(mixCard(`Mix ${a.name}`, plural(a.trackCount, 'canción', 'canciones'), { albumId: a.coverAlbumId ?? a.id, hasCover: !!a.coverAlbumId }, () => playArtist(a.id, { shuffle: true })));
  root.append(section('Hecho para ti', hscroll(...mixes)));
  return root;
}
