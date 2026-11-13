// "Enviar al Onkyo": hoja con estado, controles y volumen del receptor. Solo administradores.
import { h, icon, fill, fmtTime } from './dom.js';
import { get, post, errorText } from './api.js';
import * as player from './player.js';
import { openSheet, toast } from './ui.js';

let available = false;
export const setOnkyoAvailable = (v) => { available = !!v; };
export const onkyoAvailable = () => available;

const ERR = {
  onkyo_sin_conexion: 'No encuentro el Onkyo en la red. Revisa que esté enchufado y con el cable de red.',
  onkyo_no_enciende: 'El Onkyo no encendió. Prueba con el botón de su control.',
  sin_canciones: 'No hay canciones listas en la cola.',
  onkyo_mp3_fallo: 'No pude preparar el MP3 de esta canción.',
  onkyo_rechazo: 'El Onkyo rechazó la canción.',
  onkyo_error: 'El Onkyo no pudo reproducirla.',
};
const errMsg = (e) => (ERR[e?.code] ? ERR[e.code] + (e.detail ? ` (${String(e.detail).slice(0, 70)})` : '') : errorText(e));

// ---------- control remoto: los botones normales de la app (mini reproductor, tarjeta, pantalla de bloqueo) mandan al Onkyo ----------
let rs = null;   // último estado conocido del Onkyo
let rsAt = 0;
let remoteTimer = null;
let ticks = 0;
const playingNow = () => !!rs && (rs.state === 'playing' || rs.state === 'loading');
const interp = () => (rs ? Math.min(rs.position + (rs.state === 'playing' ? (Date.now() - rsAt) / 1000 : 0), rs.track?.duration || 1e9) : 0);
function setStatus(s) { rs = s; rsAt = Date.now(); if (s.index >= 0) player.syncIndex(s.index); player.refresh(); }
async function rcall(body) {
  try { setStatus(await post('/api/onkyo/control', body)); } catch (e) { toast(errMsg(e)); }
}
function leaveRemote({ stop = true } = {}) {
  clearInterval(remoteTimer); remoteTimer = null;
  player.setRemote(null);
  if (stop) post('/api/onkyo/control', { action: 'stop' }).catch(() => {});
}
export function startRemote(s) {
  rs = s; rsAt = Date.now();
  player.setRemote({
    playing: playingNow, position: interp, duration: () => rs?.track?.duration || 0,
    toggle: () => rcall(playingNow() ? { action: 'pause' } : rs?.state === 'stopped' ? { action: 'jump', index: rs.index } : { action: 'resume' }),
    next: () => rcall({ action: 'next' }), prev: () => rcall({ action: 'prev' }), jump: (i) => rcall({ action: 'jump', index: i }),
    leave: () => leaveRemote(),
  });
  if (s.index >= 0) player.syncIndex(s.index);
  clearInterval(remoteTimer);
  ticks = 0;
  remoteTimer = setInterval(async () => {
    if (++ticks % 5) { player.tickTime(); return; } // la barra avanza sola; cada 2,5 s se pregunta al Onkyo
    try {
      const n = await get('/api/onkyo');
      if (n.online && !n.power) { leaveRemote({ stop: false }); toast('El Onkyo se apagó.'); return; }
      if (n.online) setStatus(n);
    } catch { /* un fallo suelto no corta el control */ }
  }, 500);
}
const STATE = { playing: 'Sonando', paused: 'En pausa', loading: 'Cargando…', stopped: 'Detenido', idle: 'Sin música' };

export function openOnkyo() {
  openSheet((box, o) => {
    let s = null;
    let busy = false;
    let dragging = false;
    let gone = false;
    let misses = 0; // avisos seguidos de "no responde" (uno suelto no se muestra)

    const status = h('div', { class: 'onk-status' }, 'Buscando el Onkyo…');
    const now = h('div', { class: 'onk-now' });
    const ctl = h('div', { class: 'onk-ctl' });
    const volLabel = h('span', { class: 'onk-vol-n' }, '');
    const vol = h('input', { class: 'range', type: 'range', min: 0, max: 50, value: 0, step: 1, 'aria-label': 'Volumen del Onkyo' });
    const sendBtn = h('button', { class: 'btn btn-primary', onclick: send }, 'Enviar lo que suena al Onkyo');
    const powerBtn = h('button', { class: 'btn btn-secondary', onclick: togglePower }, 'Encender');
    const backBtn = h('button', { class: 'btn btn-ghost', onclick: () => { leaveRemote(); o.close(); } }, 'Dejar de usar el Onkyo');
    const hint = h('p', { class: 'onk-hint' }, 'Se envía la cola actual. El Onkyo toma la música por la red de tu casa, sin Bluetooth.');

    vol.addEventListener('input', () => { dragging = true; volLabel.textContent = vol.value; vol.style.setProperty('--p', vol.value / vol.max); });
    // El volumen se manda en segundo plano: no cambia la pantalla ni espera al Onkyo.
    vol.addEventListener('change', async () => {
      try { await post('/api/onkyo/volume', { level: Number(vol.value) }); } catch (e) { toast(errMsg(e)); }
      setTimeout(() => { dragging = false; }, 1200);
    });

    const btn = (ico, label, fn) => h('button', { class: 'icon-btn', 'aria-label': label, onclick: fn }, icon(ico));

    function render() {
      if (gone) return;
      if (!s) return;
      const live = s.online && s.power;
      status.textContent = s.error && s.state === 'stopped' ? `No pude reproducir: ${String(s.error).slice(0, 90)}` : !s.online && misses < 2 ? 'Conectando…' : !s.online ? 'No responde. Revisa que esté enchufado y con el cable de red.'
        : !s.power ? 'Apagado'
          : `Encendido · ${s.input === '2B' ? 'entrada Red (NET)' : 'otra entrada'}${s.state && s.state !== 'idle' ? ` · ${STATE[s.state] || ''}` : ''}`;
      status.classList.toggle('bad', (!s.online && misses >= 2) || !!(s.error && s.state === 'stopped'));
      fill(now, s.track && live ? [h('div', { class: 't' }, s.track.title), h('div', { class: 's' }, `${s.track.artistName} · ${fmtTime(s.position)} / ${fmtTime(s.track.duration)}`)] : null);
      const pl = s.state === 'playing' || s.state === 'loading';
      fill(ctl, s.track && live ? [
        btn('prev', 'Anterior', () => call('/api/onkyo/control', { action: 'prev' })),
        h('button', { class: 'play', 'aria-label': pl ? 'Pausar' : 'Seguir', onclick: () => call('/api/onkyo/control', { action: pl ? 'pause' : (s.state === 'stopped' ? 'jump' : 'resume'), index: s.index }) }, icon(pl ? 'pause' : 'play')),
        btn('next', 'Siguiente', () => call('/api/onkyo/control', { action: 'next' })),
      ] : null);
      vol.max = String(s.maxVolume || 50);
      vol.disabled = !live;
      if (!dragging && s.volume != null) { vol.value = String(Math.min(s.volume, s.maxVolume)); volLabel.textContent = vol.value; vol.style.setProperty('--p', vol.value / vol.max); }
      powerBtn.textContent = s.power ? 'Apagar el Onkyo' : 'Encender el Onkyo';
      powerBtn.disabled = busy || !s.online;
      backBtn.hidden = !player.isRemote();
      sendBtn.textContent = player.isRemote() ? 'Enviar de nuevo la cola actual' : 'Enviar lo que suena al Onkyo';
      sendBtn.disabled = busy || !s.online || !player.state().queue.length;
    }

    async function call(url, body) {
      try { s = await post(url, body); if (player.isRemote()) setStatus(s); render(); } catch (e) { toast(errMsg(e)); refresh(); }
    }
    async function refresh() {
      if (gone || busy) return;
      if (dragging) return;
      try { s = await get('/api/onkyo'); } catch (e) { misses++; if (misses >= 2) status.textContent = errMsg(e); return; }
      misses = s.online ? 0 : misses + 1;
      if (player.isRemote() && s.online) setStatus(s);
      render();
    }
    async function send() {
      const st = player.state();
      const cur = player.current();
      const ids = st.queue.map((t) => t.id);
      if (!ids.length) return;
      busy = true; render();
      status.textContent = 'Enviando… si estaba apagado puede tardar unos segundos.';
      try {
        if (!player.isRemote() && player.isPlayingUI(st)) player.toggle(); // el teléfono se calla para que no suenen los dos
        s = await post('/api/onkyo/play', { ids, index: Math.max(0, ids.indexOf(cur?.id)) });
        startRemote(s);
      } catch (e) { toast(errMsg(e)); }
      busy = false;
      render();
    }
    async function togglePower() {
      busy = true; render();
      status.textContent = s?.power ? 'Apagando…' : 'Encendiendo… puede tardar unos segundos.';
      try {
        const turningOff = !!s?.power;
        s = await post('/api/onkyo/power', { on: !turningOff });
        if (turningOff && player.isRemote()) leaveRemote({ stop: false });
      } catch (e) { toast(errMsg(e)); }
      busy = false;
      render();
    }

    box.append(
      h('h3', null, 'Onkyo TX-8130'), status, now, ctl,
      h('div', { class: 'onk-vol' }, icon('speaker'), vol, volLabel),
      h('div', { class: 'onk-actions' }, sendBtn, powerBtn, backBtn), hint);
    refresh();
    const timer = setInterval(refresh, 2500);
    o.onClose = () => { gone = true; clearInterval(timer); };
  });
}
