import { h, icon } from '../dom.js';
import { get, errorText } from '../api.js';
import { cover, trackRow, emptyState, section, albumCard, hscroll, artistCard, clear } from '../ui.js';

const KEY = 'ebs_recent_searches';
const loadRecent = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]').slice(0, 8); } catch { return []; } };
const saveRecent = (q) => {
  try { localStorage.setItem(KEY, JSON.stringify([q, ...loadRecent().filter((x) => x !== q)].slice(0, 8))); } catch { /* nada */ }
};

export async function search() {
  const input = h('input', { type: 'search', placeholder: '¿Qué quieres escuchar?', 'aria-label': 'Buscar', autocomplete: 'off', autocapitalize: 'off', enterKeyHint: 'search', maxLength: 80 });
  const clearBtn = h('button', { class: 'icon-btn clear', hidden: true, 'aria-label': 'Borrar búsqueda', onclick: () => { input.value = ''; run(); input.focus(); } }, icon('close'));
  const box = h('div', { class: 'searchbox' }, icon('search'), input, clearBtn);
  const out = h('div');
  const root = h('div', null, h('h1', { class: 'h1' }, 'Buscar'), box, out);
  let seq = 0, timer = null;

  function showRecent() {
    clear(out);
    const recent = loadRecent();
    if (!recent.length) { out.append(h('div', { class: 'muted', style: { padding: '8px 2px' } }, 'Prueba buscando por artista, álbum o canción.')); return; }
    out.append(h('div', { class: 'section-head' }, h('h2', { class: 'h2' }, 'Búsquedas recientes'),
      h('button', { class: 'link', onclick: () => { try { localStorage.removeItem(KEY); } catch { /* nada */ } showRecent(); } }, 'Borrar')),
    ...recent.map((q) => h('button', { class: 'row', onclick: () => { input.value = q; run(); } }, h('span', { class: 'num' }, icon('clock')), h('div', { class: 'main' }, h('div', { class: 't' }, q)))));
  }

  async function run() {
    const q = input.value.trim();
    clearBtn.hidden = !input.value;
    const my = ++seq;
    if (!q) { showRecent(); return; }
    try {
      const r = await get(`/api/search?q=${encodeURIComponent(q)}`);
      if (my !== seq) return;
      clear(out);
      if (!r.artists.length && !r.albums.length && !r.tracks.length) {
        out.append(emptyState('search', `No encontramos nada para “${q}”`, 'Revisa cómo está escrito o prueba con otra palabra.'));
        return;
      }
      const remember = () => saveRecent(q);
      out.addEventListener('click', remember, { once: true });
      if (r.artists.length) out.append(section('Artistas', hscroll(...r.artists.map((a) => artistCard({ ...a, albumCount: null })))));
      if (r.albums.length) out.append(section('Álbumes', hscroll(...r.albums.map(albumCard))));
      if (r.tracks.length) out.append(section('Canciones', h('div', { class: 'tracklist' }, ...r.tracks.map((t, i) => trackRow(t, { list: r.tracks, index: i, showCover: true })))));
    } catch (e) {
      if (my === seq) { clear(out); out.append(emptyState('wave', 'No pudimos buscar', errorText(e))); }
    }
  }
  input.addEventListener('input', () => { clearBtn.hidden = !input.value; clearTimeout(timer); timer = setTimeout(run, 220); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); input.blur(); } });
  showRecent();
  return root;
}
