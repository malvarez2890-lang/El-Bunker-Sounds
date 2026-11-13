// Reproductor: cola, aleatorio, repetir, Media Session (pantalla bloqueada) y recuerdo de lo último que sonaba.
import { get, post, coverUrl, streamUrl } from './api.js';

const audio = new Audio();
audio.preload = 'auto';
audio.setAttribute('playsinline', '');

const subs = { change: new Set(), time: new Set(), error: new Set() };
const emit = (type, arg) => subs[type].forEach((fn) => fn(arg));
export const on = (type, fn) => { subs[type].add(fn); return () => subs[type].delete(fn); };

const st = {
  original: [],      // cola en el orden original
  queue: [],         // cola en el orden de reproducción
  index: -1,
  shuffle: false,
  repeat: 'off',     // off | all | one
  playing: false,
  loadingTrack: false,
};
let errorStreak = 0;
let countedPlayFor = null;
let pendingSeek = null;

export const state = () => st;
export const current = () => st.queue[st.index] || null;
export const position = () => audio.currentTime || 0;
export const duration = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : current()?.duration || 0);

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function changed() { saveSoon(); emit('change', st); }

/** Carga la canción en el reproductor. */
function load(index, { autoplay = true, startAt = 0 } = {}) {
  const t = st.queue[index];
  if (!t) return;
  st.index = index;
  countedPlayFor = null;
  pendingSeek = startAt > 0 ? startAt : null;
  audio.src = streamUrl(t.id);
  audio.currentTime = 0;
  updateMediaSession();
  if (autoplay) {
    const p = audio.play();
    if (p?.catch) p.catch((err) => { if (err?.name !== 'AbortError') { st.playing = false; changed(); } });
  }
  changed();
}

/** Reproduce una lista desde una posición. shuffle:true = botón "Aleatorio"; false = en orden; sin indicar = mantiene el modo. */
export function playTracks(tracks, startIndex = 0, { shuffle } = {}) {
  const ready = tracks.filter((t) => t.ready !== false);
  if (!ready.length) return;
  const start = tracks[startIndex]?.ready === false ? ready[0] : tracks[startIndex] || ready[0];
  st.original = ready.slice();
  if (shuffle === true || shuffle === false) st.shuffle = shuffle; // sin indicar: se mantiene el modo actual
  if (st.shuffle) {
    // En modo aleatorio la canción tocada va primero (si se pidió una) y el resto se mezcla.
    const rest = shuffled(ready.filter((t) => t.id !== start.id));
    st.queue = shuffle === true ? shuffled(ready) : [start, ...rest];
    st.index = 0;
  } else {
    st.queue = ready.slice();
    st.index = Math.max(0, ready.findIndex((t) => t.id === start.id));
  }
  errorStreak = 0;
  load(st.index);
}

export function toggle() {
  if (!current()) return;
  if (audio.paused) {
    const p = audio.play();
    if (p?.catch) p.catch(() => {});
  } else audio.pause();
}

export function next({ auto = false } = {}) {
  if (!st.queue.length) return;
  if (auto && st.repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  let i = st.index + 1;
  if (i >= st.queue.length) {
    if (auto && st.repeat === 'off') { // terminó la cola: se detiene al principio de la última canción
      audio.pause(); audio.currentTime = 0; st.playing = false; changed(); return;
    }
    i = 0;
  }
  load(i);
}

export function prev() {
  if (!st.queue.length) return;
  if (audio.currentTime > 3 || st.index === 0) { audio.currentTime = 0; return; }
  load(st.index - 1);
}

export function seek(sec) {
  if (!Number.isFinite(sec)) return;
  audio.currentTime = Math.max(0, Math.min(sec, duration() || sec));
  updatePositionState();
}

export function jumpTo(i) { if (st.queue[i]) load(i); }

export function toggleShuffle() {
  const cur = current();
  st.shuffle = !st.shuffle;
  if (!cur) { changed(); return; }
  if (st.shuffle) {
    st.queue = [cur, ...shuffled(st.queue.filter((t, i) => i !== st.index))];
    st.index = 0;
  } else {
    const order = new Map(st.original.map((t, i) => [t.id, i]));
    st.queue = st.queue.slice().sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
    st.index = st.queue.findIndex((t) => t.id === cur.id);
  }
  changed();
}

export function cycleRepeat() {
  st.repeat = st.repeat === 'off' ? 'all' : st.repeat === 'all' ? 'one' : 'off';
  changed();
}

export function playNext(track) {
  if (track.ready === false) return;
  if (!st.queue.length) { playTracks([track], 0); return; }
  st.queue.splice(st.index + 1, 0, track);
  st.original.push(track);
  changed();
}
export function addToQueue(track) {
  if (track.ready === false) return;
  if (!st.queue.length) { playTracks([track], 0); return; }
  st.queue.push(track);
  st.original.push(track);
  changed();
}
export function removeFromQueue(i) {
  if (i === st.index || !st.queue[i]) return;
  const [t] = st.queue.splice(i, 1);
  st.original = st.original.filter((x) => x.id !== t.id);
  if (i < st.index) st.index--;
  changed();
}

/** Mantiene el corazón de las canciones al día en la cola sin recargar. */
export function setFav(trackId, fav) {
  for (const list of [st.queue, st.original]) for (const t of list) if (t.id === trackId) t.fav = fav;
  emit('change', st);
}

// ---------- eventos del audio ----------
audio.addEventListener('play', () => { st.playing = true; if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; changed(); });
audio.addEventListener('pause', () => { st.playing = false; if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; changed(); });
audio.addEventListener('ended', () => next({ auto: true }));
audio.addEventListener('loadedmetadata', () => {
  if (pendingSeek != null) { audio.currentTime = Math.min(pendingSeek, audio.duration || pendingSeek); pendingSeek = null; }
  updatePositionState();
  emit('time');
});
audio.addEventListener('playing', () => {
  errorStreak = 0;
  const t = current();
  if (t && countedPlayFor !== t.id) { countedPlayFor = t.id; post('/api/plays', { trackId: t.id }).catch(() => {}); }
});
let lastTick = 0;
audio.addEventListener('timeupdate', () => {
  emit('time');
  const now = Date.now();
  if (now - lastTick > 1000) { lastTick = now; updatePositionState(); }
  if (now - lastSave > 5000) saveSoon(true);
});
audio.addEventListener('error', () => {
  if (!current()) return;
  errorStreak++;
  emit('error', current());
  if (errorStreak < 3 && st.index < st.queue.length - 1) setTimeout(() => next({ auto: true }), 600);
  else { st.playing = false; changed(); }
});

// ---------- pantalla bloqueada / controles del celular ----------
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const t = current();
  if (!t) { navigator.mediaSession.metadata = null; return; }
  const artwork = t.hasCover
    ? [['s', 240], ['m', 640], ['l', 1200]].map(([v, n]) => ({ src: coverUrl(t.albumId, v, t.coverV), sizes: `${n}x${n}`, type: 'image/jpeg' }))
    : [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }];
  navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artistName, album: t.albumTitle, artwork });
}
function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = audio.duration;
  if (!Number.isFinite(d) || d <= 0) return;
  try { navigator.mediaSession.setPositionState({ duration: d, playbackRate: audio.playbackRate || 1, position: Math.min(audio.currentTime, d) }); } catch { /* algunos navegadores no lo aceptan */ }
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const set = (name, fn) => { try { ms.setActionHandler(name, fn); } catch { /* acción no disponible */ } };
  set('play', () => { audio.play().catch(() => {}); });
  set('pause', () => audio.pause());
  set('previoustrack', () => prev());
  set('nexttrack', () => next());
  // OJO: si se registran seekbackward/seekforward, iOS muestra "±10 s" en vez de canción anterior/siguiente. Para música no se registran.
  set('seekto', (d) => { if (d.fastSeek && audio.fastSeek) audio.fastSeek(d.seekTime); else seek(d.seekTime); });
  set('stop', () => { audio.pause(); seek(0); });
}

// ---------- recordar lo último que sonaba ----------
const KEY = 'ebs_player_v1';
let saveTimer = null;
let lastSave = 0;
function saveSoon(now = false) {
  clearTimeout(saveTimer);
  const doSave = () => {
    lastSave = Date.now();
    try {
      if (!st.queue.length) { localStorage.removeItem(KEY); return; }
      localStorage.setItem(KEY, JSON.stringify({
        ids: st.queue.map((t) => t.id), orig: st.original.map((t) => t.id), index: st.index, pos: Math.floor(audio.currentTime || 0),
        shuffle: st.shuffle, repeat: st.repeat,
      }));
    } catch { /* almacenamiento no disponible */ }
  };
  if (now) doSave(); else saveTimer = setTimeout(doSave, 400);
}

export async function restore() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { saved = null; }
  if (!saved?.ids?.length) return;
  try {
    const ids = [...new Set([...saved.ids, ...(saved.orig || [])])];
    const { tracks } = await get(`/api/tracks?ids=${ids.slice(0, 300).join(',')}`);
    const by = new Map(tracks.map((t) => [t.id, t]));
    const queue = saved.ids.map((i) => by.get(i)).filter(Boolean);
    if (!queue.length) return;
    const curId = saved.ids[saved.index];
    st.queue = queue;
    st.original = (saved.orig || saved.ids).map((i) => by.get(i)).filter(Boolean);
    st.index = Math.max(0, queue.findIndex((t) => t.id === curId));
    st.shuffle = !!saved.shuffle;
    st.repeat = saved.repeat || 'off';
    load(st.index, { autoplay: false, startAt: saved.pos || 0 });
  } catch { /* si falla, simplemente no se restaura */ }
}

export function reset() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  st.queue = []; st.original = []; st.index = -1; st.playing = false;
  try { localStorage.removeItem(KEY); } catch { /* nada */ }
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  emit('change', st);
}
