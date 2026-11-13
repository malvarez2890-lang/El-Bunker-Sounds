// Reproductor: cola, aleatorio, repetir, Media Session (pantalla bloqueada) y recuerdo de lo último que sonaba.
import { get, post, coverUrl, streamUrl } from './api.js';

// El audio se descarga COMPLETO a la memoria del teléfono antes de sonar (y la canción siguiente se prepara mientras suena la actual).
// Así saltar a otro minuto, retomar donde ibas y pasar a la siguiente funcionan igual en cualquier teléfono, sin depender de la red.
// Dos reproductores ("mazos"): mientras uno suena, el otro ya tiene cargada la canción siguiente. Cerca del final, la siguiente
// arranca SIN esperar a que termine la actual: con el teléfono bloqueado iOS congela la app justo cuando el audio se detiene, y la
// orden de "pasar a la siguiente" se quedaba esperando hasta desbloquear.
const mkAudio = (name) => { const a = new Audio(); a.preload = 'auto'; a.setAttribute('playsinline', ''); a.dataset.deck = name; return a; };
const decks = [mkAudio('A'), mkAudio('B')];
let audio = decks[0];  // el que suena (o sonaría)
let spare = decks[1];  // el que tiene lista la siguiente

const subs = { change: new Set(), time: new Set(), error: new Set(), blocked: new Set() };
const emit = (type, arg) => subs[type].forEach((fn) => fn(arg));
export const on = (type, fn) => { subs[type].add(fn); return () => subs[type].delete(fn); };

const st = {
  original: [],      // cola en el orden original
  queue: [],         // cola en el orden de reproducción
  index: -1,
  shuffle: false,
  repeat: 'off',     // off | all | one
  playing: false,
  loading: false,    // descargando la canción
  wantPlay: false,   // el usuario quiere que suene (aunque todavía se esté descargando)
};
let errorStreak = 0;
let countedPlayFor = null;
let pendingSeek = null;
let loadToken = 0;
let loadedId = null;     // canción que realmente está cargada en el reproductor
let restorePos = 0;      // posición guardada de la última vez (se usa al apretar play)

// Modo "control remoto": la música suena en otro aparato (el Onkyo) y los botones de la app lo manejan a él.
// El teléfono queda en silencio; la cola de aquí es la misma que se envió, así que el índice coincide.
let remote = null; // { playing(), position(), duration(), toggle(), next(), prev(), jump(i), leave() }
export const setRemote = (r) => { remote = r; if (r) { st.playing = false; st.wantPlay = false; } emit('change'); emit('time'); };
export const isRemote = () => !!remote;
/** El aparato remoto cambió de canción: se muestra la misma aquí, sin cargar ni sonar nada en el teléfono. */
export function syncIndex(i) { if (remote && st.queue[i] && st.index !== i) { st.index = i; emit('change'); } }
export const refresh = () => { emit('change'); emit('time'); };
export const tickTime = () => emit('time');

/** Lo que muestran los botones: suena, o va a sonar apenas termine de descargar. */
export const isPlayingUI = (s = st) => (remote ? remote.playing() : s.playing || (s.loading && s.wantPlay));
export const state = () => st;
export const current = () => st.queue[st.index] || null;
const isLoaded = () => !!current() && loadedId === current().id;
export const position = () => (remote ? remote.position() : isLoaded() ? audio.currentTime || 0 : restorePos || pendingSeek || 0);
export const duration = () => (remote ? remote.duration() || current()?.duration || 0 : isLoaded() && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : current()?.duration || 0);

// ---------- registro para diagnóstico (pantalla "Diagnóstico del audio") ----------
const logs = [];
function log(e, extra = '', el = audio) {
  const seek = el.seekable?.length ? `${el.seekable.start(0).toFixed(1)}-${el.seekable.end(el.seekable.length - 1).toFixed(1)}` : '-';
  logs.push(`${new Date().toLocaleTimeString('es')} [${el.dataset.deck}${el === audio ? '*' : ''}] ${e} t=${(el.currentTime || 0).toFixed(1)} rs=${el.readyState} ns=${el.networkState} seek=${seek}${extra ? ' ' + extra : ''}`);
  if (logs.length > 80) logs.shift();
}
for (const el of decks) {
  for (const ev of ['loadedmetadata', 'canplay', 'playing', 'pause', 'ended', 'error', 'stalled', 'waiting', 'seeking', 'seeked', 'emptied', 'abort']) {
    el.addEventListener(ev, () => log(ev, ev === 'error' ? `code=${el.error?.code}` : '', el));
  }
}
export function debugInfo() {
  return {
    logs: logs.slice().reverse(),
    audio: {
      paused: audio.paused, ended: audio.ended, currentTime: audio.currentTime, duration: audio.duration, readyState: audio.readyState,
      networkState: audio.networkState, source: isSilent() ? 'silencio' : audio.src.startsWith('blob:') ? 'memoria (blob)' : audio.src ? 'red' : 'ninguna',
      seekable: audio.seekable?.length ? `${audio.seekable.start(0).toFixed(1)} a ${audio.seekable.end(audio.seekable.length - 1).toFixed(1)}` : 'nada',
    },
    spare: { id: spareId, paused: spare.paused, source: spare.src.startsWith('blob:') ? 'blob' : spare.src ? 'otro' : 'ninguna' },
    cache: [...cache.entries()].map(([id, e]) => `${id}${e.url ? ' listo' : ' bajando'}`),
    queue: `${st.index + 1}/${st.queue.length}`, loadedId, state: { ...st, queue: undefined, original: undefined },
  };
}

// ---------- descarga de canciones a memoria ----------
const cache = new Map(); // id de canción -> { controller, url, promise }
function entryFor(t) {
  let e = cache.get(t.id);
  if (e) return e;
  const controller = new AbortController();
  e = { controller, url: null, promise: null };
  e.promise = fetch(streamUrl(t.id), { credentials: 'same-origin', signal: controller.signal })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); })
    .then((b) => { e.url = URL.createObjectURL(b.type === 'audio/mp4' ? b : new Blob([b], { type: 'audio/mp4' })); log('descarga lista', `id=${t.id} ${(b.size / 1048576).toFixed(1)}MB`); return e.url; });
  e.promise.catch((err) => { if (cache.get(t.id) === e) cache.delete(t.id); log('descarga falló', `id=${t.id} ${err.message}`); });
  cache.set(t.id, e);
  return e;
}
function trim(keep) {
  for (const [id, e] of cache) {
    if (keep.has(id)) continue;
    e.controller.abort();
    if (e.url) URL.revokeObjectURL(e.url);
    cache.delete(id);
  }
}
/** Mantiene en memoria la anterior, la actual y la siguiente, y empieza a bajar la siguiente. */
function prefetch(index) {
  const q = st.queue;
  const next = q[index + 1] || (st.repeat === 'all' ? q[0] : null);
  const prev = q[index - 1];
  trim(new Set([q[index]?.id, next?.id, prev?.id].filter((x) => x != null)));
  if (next) entryFor(next).promise.catch(() => {});
  refreshSpare();
}

// ---------- desbloqueo del audio (iPhone solo deja sonar si el primer play viene de un toque) ----------
const SILENT = '/silence.wav'; // medio segundo de silencio, propio de la app (el CSP no deja usar data: en audio)
const isSilentEl = (el) => el.src.endsWith('/silence.wav');
const isSilent = () => isSilentEl(audio);
let unlocked = false;
function unlock() {
  if (unlocked) return;
  if (audio.src && !isSilent()) { unlocked = true; return; } // ya hay una canción cargada: el reproductor ya está habilitado
  unlocked = true;
  for (const el of decks) {
    try {
      if (el.src && !isSilentEl(el)) continue;
      el.src = SILENT;
      const p = el.play();
      // Si otra canción se carga enseguida, este play se interrumpe (AbortError): es normal y NO significa que falló.
      if (p?.catch) p.catch((err) => { if (err?.name === 'NotAllowedError') unlocked = false; });
    } catch { unlocked = false; }
  }
  log('desbloqueo');
}

// ---------- traspaso anticipado a la siguiente canción ----------
let spareId = null;
let spareToken = 0;
const nextIndexForHandoff = () => {
  if (st.repeat === 'one') return -1;
  const i = st.index + 1;
  return i < st.queue.length ? i : (st.repeat === 'all' && st.queue.length > 1 ? 0 : -1);
};
/** Deja lista, en el reproductor libre, la canción que viene. */
function refreshSpare() {
  const ni = nextIndexForHandoff();
  const nt = ni >= 0 ? st.queue[ni] : null;
  if (!nt) { spareId = null; return; }
  if (spareId === nt.id) return;
  if (!spare.paused && !spare.ended && !isSilentEl(spare)) return; // todavía suena el final de la anterior: se reintenta luego
  const my = ++spareToken;
  spareId = null;
  entryFor(nt).promise.then((url) => {
    if (my !== spareToken) return;
    if (!spare.paused && !isSilentEl(spare)) return;
    spare.src = url;
    spare.load();
    spareId = nt.id;
    log('siguiente lista', `id=${nt.id}`, spare);
  }).catch(() => {});
}
let handingOff = false;
function maybeHandoff() {
  if (handingOff || spareId == null || isSilent() || audio.paused) return;
  const d = audio.duration;
  if (!(d > 0) || d - audio.currentTime > 0.5) return;
  const ni = nextIndexForHandoff();
  const nt = ni >= 0 ? st.queue[ni] : null;
  if (!nt || nt.id !== spareId) return;
  const target = spare;
  handingOff = true;
  try { target.currentTime = 0; } catch { /* ya está al principio */ }
  const commit = () => {
    handingOff = false;
    if (target !== spare || spareId !== nt.id) { target.pause(); return; } // la cola cambió mientras tanto
    const old = audio;
    audio = target; spare = old;
    spareId = null; spareToken++;
    st.index = ni; loadedId = nt.id; pendingSeek = null; restorePos = 0; st.loading = false; st.wantPlay = true;
    countedPlayFor = nt.id; post('/api/plays', { trackId: nt.id }).catch(() => {});
    log('traspaso', `a id=${nt.id}`);
    updateMediaSession();
    syncPlaying();
    prefetch(ni);
  };
  // Solo se hace el cambio si el segundo reproductor realmente arrancó; si el teléfono lo rechaza, sigue el camino normal (al terminar).
  const p = target.play();
  if (p?.then) p.then(commit, (err) => { handingOff = false; log('traspaso rechazado', err?.name); });
  else commit();
}

function startPlayback() {
  const p = audio.play();
  if (p?.catch) p.catch((err) => {
    if (err?.name === 'AbortError') return;
    st.playing = false; st.wantPlay = false; log('play rechazado', err?.name); emit('blocked'); changed();
  });
}

function changed() { saveSoon(); emit('change', st); }

/** Carga la canción de la cola (descargándola si hace falta) y la reproduce. */
function load(index, { autoplay = true, startAt = 0 } = {}) {
  const t = st.queue[index];
  if (!t) return;
  st.index = index;
  countedPlayFor = null;
  pendingSeek = startAt > 0 ? startAt : null;
  restorePos = 0;
  st.wantPlay = autoplay;
  const my = ++loadToken;
  const e = entryFor(t);

  const apply = (url) => {
    if (my !== loadToken) return;
    st.loading = false;
    loadedId = t.id;
    spareId = spareId === t.id ? null : spareId; // la lista previa puede ya no corresponder
    audio.src = url;
    log('cargada', `id=${t.id}`);
    if (st.wantPlay) startPlayback();
    prefetch(index);
    changed();
  };
  if (e.url) apply(e.url);
  else {
    st.loading = true;
    if (!audio.paused && !isSilent()) audio.pause(); // la anterior se detiene mientras baja la nueva
    e.promise.then(apply).catch((err) => {
      if (my !== loadToken || err?.name === 'AbortError') return;
      st.loading = false; st.playing = false; st.wantPlay = false;
      errorStreak++; emit('error', t); changed();
      if (errorStreak < 3 && st.index < st.queue.length - 1) setTimeout(() => { if (my === loadToken) next({ auto: true }); }, 600);
    });
  }
  updateMediaSession();
  changed();
}

/** Reproduce una lista desde una posición. shuffle:true = botón "Aleatorio"; false = en orden; sin indicar = mantiene el modo. */
export function playTracks(tracks, startIndex = 0, { shuffle } = {}) {
  if (remote) remote.leave(); // elegir música nueva en el teléfono = dejar de mandar al Onkyo
  unlock();
  const ready = tracks.filter((t) => t.ready !== false);
  if (!ready.length) return;
  const start = tracks[startIndex]?.ready === false ? ready[0] : tracks[startIndex] || ready[0];
  st.original = ready.slice();
  if (shuffle === true || shuffle === false) st.shuffle = shuffle;
  if (st.shuffle) {
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

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function toggle() {
  if (!current()) return;
  if (remote) return remote.toggle();
  unlock();
  if (isPlayingUI()) {
    st.wantPlay = false;
    audio.pause();
    changed();
    return;
  }
  st.wantPlay = true;
  if (isLoaded() && !isSilent()) { startPlayback(); changed(); }
  else load(st.index, { autoplay: true, startAt: restorePos || pendingSeek || 0 }); // primera vez tras abrir la app: retoma donde iba
}

export function next({ auto = false } = {}) {
  if (!st.queue.length) return;
  if (remote) return remote.next();
  if (!auto) unlock();
  if (auto && st.repeat === 'one') { audio.currentTime = 0; startPlayback(); return; }
  let i = st.index + 1;
  if (i >= st.queue.length) {
    if (auto && st.repeat === 'off') { // terminó la cola: queda detenida
      audio.pause(); st.playing = false; st.wantPlay = false; seek(0); changed(); return;
    }
    i = 0;
  }
  load(i, { autoplay: true });
}

export function prev() {
  if (!st.queue.length) return;
  if (remote) return remote.prev();
  unlock();
  if (position() > 3 || st.index === 0) { seek(0); return; }
  load(st.index - 1);
}

export function seek(sec) {
  if (!Number.isFinite(sec)) return;
  if (remote) return remote.seek(sec); // el Onkyo salta de minuto por DLNA (Seek)
  const d = duration();
  const target = Math.max(0, d ? Math.min(sec, d) : sec);
  if (!isLoaded()) { pendingSeek = target; restorePos = target; emit('time'); return; } // todavía descargando: se aplica al cargar
  audio.currentTime = target;
  log('seek', `a ${target.toFixed(1)}`);
  updatePositionState();
  emit('time');
}

export function jumpTo(i) { if (remote) { if (st.queue[i]) remote.jump(i); return; } if (st.queue[i]) { unlock(); load(i); } }

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
  prefetch(st.index);
  changed();
}

export function cycleRepeat() {
  st.repeat = st.repeat === 'off' ? 'all' : st.repeat === 'all' ? 'one' : 'off';
  prefetch(st.index);
  changed();
}

export function playNext(track) {
  if (remote) return; // la cola del Onkyo ya está enviada: tocarla aquí la desalinearía
  if (track.ready === false) return;
  if (!st.queue.length) { playTracks([track], 0); return; }
  st.queue.splice(st.index + 1, 0, track);
  st.original.push(track);
  prefetch(st.index);
  changed();
}
export function addToQueue(track) {
  if (remote) return; // la cola del Onkyo ya está enviada: tocarla aquí la desalinearía
  if (track.ready === false) return;
  if (!st.queue.length) { playTracks([track], 0); return; }
  st.queue.push(track);
  st.original.push(track);
  prefetch(st.index);
  changed();
}
export function removeFromQueue(i) {
  if (remote) return; // la cola del Onkyo ya está enviada: tocarla aquí la desalinearía
  if (i === st.index || !st.queue[i]) return;
  const [t] = st.queue.splice(i, 1);
  st.original = st.original.filter((x) => x.id !== t.id);
  if (i < st.index) st.index--;
  prefetch(st.index);
  changed();
}

/** Mantiene el corazón de las canciones al día en la cola sin recargar. */
export function setFav(trackId, fav) {
  for (const list of [st.queue, st.original]) for (const t of list) if (t.id === trackId) t.fav = fav;
  emit('change', st);
}

// ---------- eventos del audio (solo importan los del reproductor activo) ----------
const syncPlaying = () => {
  st.playing = !audio.paused && !isSilent();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = st.playing ? 'playing' : (current() ? 'paused' : 'none');
  changed();
};
let lastTick = 0;
function wire(el) {
  const active = () => el === audio;
  el.addEventListener('play', () => { if (active() && !isSilent()) syncPlaying(); });
  el.addEventListener('pause', () => {
    if (!active()) { refreshSpare(); return; } // el reproductor anterior terminó de sonar: se prepara la siguiente
    if (!isSilent() && !el.ended) syncPlaying();
  });
  el.addEventListener('ended', () => {
    if (!active()) { refreshSpare(); return; }  // terminó el final de la canción anterior: se prepara la siguiente
    if (!isSilent() && el.ended) next({ auto: true }); // si el evento es viejo (otra canción ya cargada) se ignora
  });
  el.addEventListener('loadedmetadata', () => {
    if (!active() || isSilent()) return;
    if (pendingSeek != null) { el.currentTime = Math.min(pendingSeek, (el.duration || pendingSeek) - 0.1); pendingSeek = null; }
    updatePositionState();
    emit('time');
  });
  el.addEventListener('playing', () => {
    if (!active() || isSilent()) return;
    errorStreak = 0;
    const t = current();
    if (t && countedPlayFor !== t.id) { countedPlayFor = t.id; post('/api/plays', { trackId: t.id }).catch(() => {}); }
  });
  el.addEventListener('timeupdate', () => {
    if (!active() || isSilent()) return;
    emit('time');
    if (spareId == null) refreshSpare();
    maybeHandoff();
    const now = Date.now();
    if (now - lastTick > 1000) { lastTick = now; updatePositionState(); }
    if (now - lastSave > 5000) saveSoon(true);
  });
  el.addEventListener('error', () => {
    if (!active() || isSilent() || !current()) return;
    errorStreak++;
    emit('error', current());
    if (errorStreak < 3 && st.index < st.queue.length - 1) setTimeout(() => next({ auto: true }), 600);
    else { st.playing = false; changed(); }
  });
}
decks.forEach(wire);

// ---------- pantalla bloqueada / controles del celular ----------
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  registerMediaHandlers();
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
/** Botones de la pantalla de bloqueo: solo anterior/siguiente (como Spotify). Se vuelven a registrar en cada canción por si iOS los olvida. */
function registerMediaHandlers() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const set = (name, fn) => { try { ms.setActionHandler(name, fn); } catch { /* acción no disponible */ } };
  set('play', () => { if (!isPlayingUI()) toggle(); });
  set('pause', () => { if (isPlayingUI()) toggle(); });
  set('previoustrack', () => prev());
  set('nexttrack', () => next());
  // Si se registraran seekbackward/seekforward, iOS mostraría "±10 s" en vez de anterior/siguiente. Se dejan explícitamente sin acción.
  set('seekbackward', null);
  set('seekforward', null);
  set('seekto', (d) => { if (d.fastSeek && audio.fastSeek) audio.fastSeek(d.seekTime); else seek(d.seekTime); });
  set('stop', () => { st.wantPlay = false; audio.pause(); seek(0); });
}
registerMediaHandlers();

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
        ids: st.queue.map((t) => t.id), orig: st.original.map((t) => t.id), index: st.index, pos: Math.floor(position()),
        shuffle: st.shuffle, repeat: st.repeat,
      }));
    } catch { /* almacenamiento no disponible */ }
  };
  if (now) doSave(); else saveTimer = setTimeout(doSave, 400);
}

// Al salir de la app (o bloquear el teléfono) se guarda la posición exacta.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveSoon(true); });
window.addEventListener('pagehide', () => saveSoon(true));

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
    // No se descarga nada hasta que aprietes play (así no gasta datos solo por abrir la app); retoma desde donde ibas.
    restorePos = saved.pos || 0;
    updateMediaSession();
    changed();
    emit('time');
  } catch { /* si falla, simplemente no se restaura */ }
}

export function reset() {
  loadToken++; spareToken++; spareId = null;
  for (const el of decks) { el.pause(); el.removeAttribute('src'); el.load(); }
  trim(new Set());
  loadedId = null; restorePos = 0; pendingSeek = null; unlocked = false;
  st.queue = []; st.original = []; st.index = -1; st.playing = false; st.loading = false; st.wantPlay = false;
  try { localStorage.removeItem(KEY); } catch { /* nada */ }
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  emit('change', st);
}
