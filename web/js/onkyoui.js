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
};
const errMsg = (e) => ERR[e?.code] || errorText(e);
const STATE = { playing: 'Sonando', paused: 'En pausa', loading: 'Cargando…', stopped: 'Detenido', idle: 'Sin música' };

export function openOnkyo() {
  openSheet((box, o) => {
    let s = null;
    let busy = false;
    let dragging = false;
    let gone = false;

    const status = h('div', { class: 'onk-status' }, 'Buscando el Onkyo…');
    const now = h('div', { class: 'onk-now' });
    const ctl = h('div', { class: 'onk-ctl' });
    const volLabel = h('span', { class: 'onk-vol-n' }, '');
    const vol = h('input', { class: 'range', type: 'range', min: 0, max: 50, value: 0, step: 1, 'aria-label': 'Volumen del Onkyo' });
    const sendBtn = h('button', { class: 'btn btn-primary', onclick: send }, 'Enviar lo que suena al Onkyo');
    const powerBtn = h('button', { class: 'btn btn-secondary', onclick: togglePower }, 'Encender');
    const hint = h('p', { class: 'onk-hint' }, 'Se envía la cola actual. El Onkyo toma la música por la red de tu casa, sin Bluetooth.');

    vol.addEventListener('input', () => { dragging = true; volLabel.textContent = vol.value; vol.style.setProperty('--p', vol.value / vol.max); });
    vol.addEventListener('change', async () => { await call('/api/onkyo/volume', { level: Number(vol.value) }); dragging = false; });

    const btn = (ico, label, fn) => h('button', { class: 'icon-btn', 'aria-label': label, onclick: fn }, icon(ico));

    function render() {
      if (gone) return;
      if (!s) return;
      const live = s.online && s.power;
      status.textContent = !s.online ? 'No responde. Revisa que esté enchufado y con el cable de red.'
        : !s.power ? 'Apagado'
          : `Encendido · ${s.input === '2B' ? 'entrada Red (NET)' : 'otra entrada'}${s.state && s.state !== 'idle' ? ` · ${STATE[s.state] || ''}` : ''}`;
      status.classList.toggle('bad', !s.online);
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
      sendBtn.disabled = busy || !s.online || !player.state().queue.length;
    }

    async function call(url, body) {
      try { s = await post(url, body); render(); } catch (e) { toast(errMsg(e)); refresh(); }
    }
    async function refresh() {
      if (gone || busy) return;
      try { s = await get('/api/onkyo'); } catch (e) { status.textContent = errMsg(e); return; }
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
        if (player.isPlayingUI(st)) player.toggle(); // el teléfono se calla para que no suenen los dos
        s = await post('/api/onkyo/play', { ids, index: Math.max(0, ids.indexOf(cur?.id)) });
      } catch (e) { toast(errMsg(e)); }
      busy = false;
      render();
    }
    async function togglePower() {
      busy = true; render();
      status.textContent = s?.power ? 'Apagando…' : 'Encendiendo… puede tardar unos segundos.';
      try { s = await post('/api/onkyo/power', { on: !s?.power }); } catch (e) { toast(errMsg(e)); }
      busy = false;
      render();
    }

    box.append(
      h('h3', null, 'Onkyo TX-8130'), status, now, ctl,
      h('div', { class: 'onk-vol' }, icon('speaker'), vol, volLabel),
      h('div', { class: 'onk-actions' }, sendBtn, powerBtn), hint);
    refresh();
    const timer = setInterval(refresh, 2500);
    o.onClose = () => { gone = true; clearInterval(timer); };
  });
}
