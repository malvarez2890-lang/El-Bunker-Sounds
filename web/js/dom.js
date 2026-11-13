// Utilidades mínimas para crear elementos sin plantillas HTML (así el texto nunca se interpreta como código).
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') for (const [a, b] of Object.entries(v)) el.style.setProperty(a, b);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'for') el.htmlFor = v;
    else if (k.includes('-') || typeof v === 'object') el.setAttribute(k, v === true ? '' : v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
export const clear = (el) => { el.replaceChildren(); return el; };
/** Vacía el elemento y agrega hijos (ignora null/false/undefined, a diferencia de Element.append). */
export function fill(el, ...kids) { el.replaceChildren(); return append(el, kids); }
export const add = (el, ...kids) => append(el, kids);

const S = (body) => ({ body });
const F = (body) => ({ body, fill: true });
const ICONS = {
  home: S('<path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
  compass: S('<circle cx="12" cy="12" r="9"/><path d="m15.6 8.4-2.1 5.1-5.1 2.1 2.1-5.1z"/>'),
  library: S('<rect x="3" y="4" width="4" height="16" rx="1"/><rect x="9" y="4" width="4" height="16" rx="1"/><path d="m15 5.7 3.6-1.2 3 14.2-3.6 1.2z"/>'),
  search: S('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>'),
  play: F('<path d="M8 5.6v12.8a1 1 0 0 0 1.5.86l10.4-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6z"/>'),
  pause: F('<rect x="6" y="5" width="4.6" height="14" rx="1.3"/><rect x="13.4" y="5" width="4.6" height="14" rx="1.3"/>'),
  next: F('<path d="M5.5 6v12a.8.8 0 0 0 1.25.66l8.4-6a.8.8 0 0 0 0-1.32l-8.4-6A.8.8 0 0 0 5.5 6z"/><rect x="16.8" y="5" width="2.8" height="14" rx="1.2"/>'),
  prev: F('<g transform="translate(24 0) scale(-1 1)"><path d="M5.5 6v12a.8.8 0 0 0 1.25.66l8.4-6a.8.8 0 0 0 0-1.32l-8.4-6A.8.8 0 0 0 5.5 6z"/><rect x="16.8" y="5" width="2.8" height="14" rx="1.2"/></g>'),
  shuffle: S('<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>'),
  repeat: S('<path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>'),
  repeat1: S('<path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/><path d="M11 10.4l1.6-.9v5"/>'),
  heart: S('<path d="M12 20.5s-7.6-4.7-9.4-9.4A5.1 5.1 0 0 1 12 6.6a5.1 5.1 0 0 1 9.4 4.5c-1.8 4.7-9.4 9.4-9.4 9.4z"/>'),
  heartFill: F('<path d="M12 20.8s-7.9-4.9-9.7-9.8A5.3 5.3 0 0 1 12 6.4a5.3 5.3 0 0 1 9.7 4.6c-1.8 4.9-9.7 9.8-9.7 9.8z"/>'),
  more: F('<circle cx="5.5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="18.5" cy="12" r="1.9"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  down: S('<path d="m6 9 6 6 6-6"/>'),
  right: S('<path d="m9 6 6 6-6 6"/>'),
  left: S('<path d="m15 6-6 6 6 6"/>'),
  close: S('<path d="M6 6l12 12M18 6 6 18"/>'),
  queue: S('<path d="M4 6h12M4 12h12M4 18h7"/><path d="m16 15 5 3.2-5 3.2z" fill="currentColor"/>'),
  clock: S('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  user: S('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  check: S('<path d="m5 12.5 5 5 9-10"/>'),
  trash: S('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  edit: S('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
  shield: S('<path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>'),
  note: S('<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>'),
  share: S('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8"/>'),
  logout: S('<path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M16 8l4 4-4 4M20 12H9"/>'),
  disc: S('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>'),
  listAdd: S('<path d="M4 6h12M4 12h8M4 18h8M17 14v6M14 17h6"/>'),
  nextUp: S('<path d="M4 6h10M4 12h6M4 18h6"/><path d="m14 12 7 4-7 4z"/>'),
  photo: S('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5L5 20"/>'),
  refresh: S('<path d="M20 11a8 8 0 1 0-2.3 6"/><path d="M20 5v6h-6"/>'),
  mail: S('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>'),
  speaker: S('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>'),
  wave: S('<path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 10v4M21 12h0"/>'),
};

export function icon(name, extra = '') {
  const def = ICONS[name] || ICONS.note;
  const span = document.createElement('span');
  span.className = `icon ${extra}`.trim();
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" ${def.fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'}>${def.body}</svg>`;
  return span;
}

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export function fmtMinutes(sec) {
  const m = Math.max(1, Math.round((sec || 0) / 60));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const KIND_LABEL = { album: 'Álbum', ep: 'EP', single: 'Sencillo' };
