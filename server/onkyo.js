// Enviar música al receptor Onkyo (TX-8130) por la red de la casa.
//  - Encendido, entrada y volumen: protocolo eISCP (TCP 60128).
//  - Reproducir: DLNA/UPnP (AVTransport). Le decimos "baja esta canción de este enlace" y el Onkyo la pide a este servidor.
//  - El enlace es temporal y firmado, y vive en un puerto aparte (solo red local). Nunca sirve nada más que esa canción.
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeJoin } from './safe-path.js';
import { createMp3Cache } from './media.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const unesc = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hms = (s) => {
  const m = /^(\d+):(\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
};
const toHms = (sec) => {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// ---------- eISCP ----------
export function iscpFrame(cmd) {
  const data = Buffer.from(`!1${cmd}\r`);
  const head = Buffer.alloc(16);
  head.write('ISCP', 0);
  head.writeUInt32BE(16, 4);
  head.writeUInt32BE(data.length, 8);
  head[12] = 1;
  return Buffer.concat([head, data]);
}
export function iscpFrames(buf) {
  const out = [];
  while (buf.length >= 16 && buf.toString('latin1', 0, 4) === 'ISCP') {
    const hs = buf.readUInt32BE(4);
    const ds = buf.readUInt32BE(8);
    if (buf.length < hs + ds) break;
    out.push(buf.toString('utf8', hs, hs + ds).replace(/[\x1a\r\n]+$/g, ''));
    buf = buf.subarray(hs + ds);
  }
  return out;
}

/** Manda un comando y espera una respuesta que empiece con `expect` (ej. "!1PWR"). Una conexión nueva por comando. */
function iscpSendRaw(cfg, cmd, expect, timeout = 2500) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let done = false;
    const sock = net.createConnection({ host: cfg.ip, port: cfg.eiscpPort });
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(expect ? new Error('sin_respuesta') : null, null), timeout);
    sock.on('connect', () => {
      sock.write(iscpFrame(cmd));
      if (!expect) setTimeout(() => finish(null, null), 350); // los comandos de acción no siempre contestan
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!expect) return;
      const hit = iscpFrames(buf).find((f) => f.startsWith(expect));
      if (hit) finish(null, hit);
    });
    sock.on('error', (e) => finish(e));
    sock.on('close', () => finish(expect ? new Error('cerrado') : null, null));
  });
}

// El Onkyo atiende mal varias conexiones a la vez (por ejemplo, estado + volumen): se hacen de a una.
let iscpQueue = Promise.resolve();
function iscpSend(cfg, cmd, expect, timeout) {
  const run = () => iscpSendRaw(cfg, cmd, expect, timeout);
  const r = iscpQueue.then(run, run);
  iscpQueue = r.catch(() => {}).then(() => sleep(80)); // una pausita entre conexiones: el equipo tarda en soltar la anterior
  return r;
}
/** Comando de acción (encender, entrada, volumen): espera el eco del equipo y reintenta si cortó la conexión. */
async function iscpDo(cfg, cmd) {
  let last;
  for (let i = 0; i < 4; i++) {
    try { return await iscpSend(cfg, cmd, `!1${cmd.slice(0, 3)}`, 1500); } catch (e) {
      if (e.message === 'sin_respuesta') return null; // lo recibió pero no contestó: se da por enviado
      last = e; await sleep(150);
    }
  }
  throw last;
}

// ---------- UPnP ----------
async function soap(url, service, action, args = '') {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${args}</u:${action}></s:Body></s:Envelope>`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${service}#${action}"` },
    body,
    signal: AbortSignal.timeout(6000),
  });
  const text = await res.text();
  if (!res.ok) {
    const code = /<errorCode>(\d+)<\/errorCode>/.exec(text)?.[1];
    const err = new Error(`upnp_${action}_${res.status}${code ? `_${code}` : ''}`);
    err.upnpCode = code ? Number(code) : null;
    throw err;
  }
  return text;
}
const tag = (xml, name) => unesc(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? '');

const DLNA_FLAGS = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
const DLNA_PN = { 'audio/mpeg': 'DLNA.ORG_PN=MP3;', 'audio/mp4': '', 'audio/wav': '' };
export function didl(track, url, mime, dlna = false) {
  const info = dlna ? `http-get:*:${mime}:${DLNA_PN[mime] || ''}${DLNA_FLAGS}` : `http-get:*:${mime}:*`;
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">`
    + `<item id="${track.id}" parentID="0" restricted="1"><dc:title>${esc(track.title)}</dc:title>`
    + `<dc:creator>${esc(track.artistName)}</dc:creator><upnp:artist>${esc(track.artistName)}</upnp:artist><upnp:album>${esc(track.albumTitle)}</upnp:album>`
    + `<upnp:class>object.item.audioItem.musicTrack</upnp:class>`
    + `<res protocolInfo="${esc(info)}">${esc(url)}</res></item></DIDL-Lite>`;
}

const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';

export function createOnkyo({ config, db, lib, log, transcoder }) {
  const cfg = config.onkyo;
  const enabled = !!(cfg.ip && cfg.lanIp);
  const out = { enabled, config: cfg };
  if (!enabled) return Object.assign(out, { status: async () => ({ enabled: false }), listen: async () => null, prepare() {}, cleanup() {}, close() {} });

  // ---- clave para firmar enlaces (se guarda para que no cambie al reiniciar) ----
  const secretFile = path.join(config.dataDir, 'onkyo.secret');
  let secret = cfg.secret;
  if (!secret) {
    try { secret = fs.readFileSync(secretFile, 'utf8').trim(); } catch { /* primera vez */ }
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      try { fs.writeFileSync(secretFile, secret, { mode: 0o600 }); } catch (e) { log.warn({ err: e.message }, 'no pude guardar la clave de enlaces'); }
    }
  }
  const sign = (payload) => b64u(crypto.createHmac('sha256', secret).update(payload).digest()).slice(0, 32);
  const MIME = { m4a: 'audio/mp4', wav: 'audio/wav', mp3: 'audio/mpeg' };
  const mp3 = cfg.format === 'mp3' ? createMp3Cache({ db, config, log, transcoder }) : null;

  /** Enlace temporal para una canción. */
  function mintUrl(trackId, ttlSec = cfg.linkTtlSec) {
    const ext = cfg.format;
    const payload = b64u(JSON.stringify({ t: trackId, f: ext, e: Math.floor(Date.now() / 1000) + ttlSec }));
    return { url: `http://${cfg.lanIp}:${cfg.lanPort}/onkyo/${payload}.${sign(payload)}.${ext}`, mime: MIME[ext] };
  }
  function verify(token, ext) {
    const m = /^([A-Za-z0-9_-]{8,200})\.([A-Za-z0-9_-]{32})$/.exec(token);
    if (!m) return null;
    const good = Buffer.from(sign(m[1]));
    const got = Buffer.from(m[2]);
    if (good.length !== got.length || !crypto.timingSafeEqual(good, got)) return null;
    try {
      const p = JSON.parse(Buffer.from(m[1], 'base64url').toString());
      if (!Number.isInteger(p.t) || p.f !== ext || !(p.e > Date.now() / 1000)) return null;
      return p.t;
    } catch { return null; }
  }

  // ---- servidor aparte (solo para el Onkyo): GET /onkyo/<token>.<ext> ----
  function fileFor(trackId, ext) {
    if (ext === 'mp3') return mp3 ? mp3.pathIfReady(trackId) : null;
    const t = db.prepare('SELECT src_rel, audio_file, audio_status FROM tracks WHERE id=? AND missing=0').get(trackId);
    if (!t) return null;
    if (ext === 'wav') {
      const f = safeJoin(config.musicDir, t.src_rel);
      return f && /\.wav$/i.test(f) ? f : null;
    }
    if (t.audio_status !== 'ok' || !t.audio_file) return null;
    return path.join(config.dataDir, 'audio', path.basename(t.audio_file));
  }
  const lan = http.createServer((req, res) => {
    const fail = (code) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405);
    const m = /^\/onkyo\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\.(m4a|wav|mp3)$/.exec((req.url || '').split('?')[0]);
    if (!m) return fail(404);
    const id = verify(m[1], m[2]);
    const file = id != null ? fileFor(id, m[2]) : null;
    if (!file) return fail(id == null ? 403 : 404);
    let size;
    try { size = fs.statSync(file).size; } catch { return fail(404); }
    const base = { 'content-type': MIME[m[2]], 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'transfermode.dlna.org': 'Streaming' };
    if (m[2] === 'mp3') base['contentfeatures.dlna.org'] = `DLNA.ORG_PN=MP3;${DLNA_FLAGS}`;
    let start = 0;
    let end = size - 1;
    let code = 200;
    const range = req.headers.range;
    if (range) {
      const r = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!r || (r[1] === '' && r[2] === '')) return fail(416);
      if (r[1] === '') { start = Math.max(0, size - Number(r[2])); } else { start = Number(r[1]); if (r[2] !== '') end = Math.min(Number(r[2]), size - 1); }
      if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
      code = 206;
      base['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    res.writeHead(code, { ...base, 'content-length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    log.info({ track: id, range: range || null, from: req.socket.remoteAddress }, 'el Onkyo pide una canción');
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  });
  lan.on('error', (e) => log.error({ err: e.message }, 'no pude abrir el puerto del Onkyo'));
  lan.requestTimeout = 0; // las canciones se transmiten despacio
  out.listen = () => new Promise((resolve) => lan.listen(cfg.lanPort, cfg.lanHost, () => resolve(lan.address().port)));
  out.lanServer = lan;

  // ---- descripción UPnP (se lee una vez y se recuerda) ----
  let control = null;
  async function avtControl() {
    if (control) return control;
    const base = `http://${cfg.ip}:${cfg.upnpPort}`;
    const xml = await (await fetch(base + cfg.descPath, { signal: AbortSignal.timeout(5000) })).text();
    for (const block of xml.match(/<service>[\s\S]*?<\/service>/g) || []) {
      if (/AVTransport/.test(tag(block, 'serviceType'))) {
        const u = tag(block, 'controlURL');
        control = new URL(u, base).href;
      }
    }
    if (!control) throw new Error('sin_avtransport');
    return control;
  }
  const av = async (action, args = '') => soap(await avtControl(), AVT, action, `<InstanceID>0</InstanceID>${args}`);

  // ---- eISCP: estado, encendido, entrada, volumen ----
  const ask = async (cmd, prefix) => (await iscpSend(cfg, cmd, `!1${prefix}`)).slice(2 + prefix.length);
  let devCache = null; // { at, val }: el estado se recuerda un instante para no molestar al equipo
  const devNow = () => devCache && Date.now() - devCache.at < 1500 ? devCache.val : null;
  async function device() {
    const hit = devNow();
    if (hit) return hit;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const pwr = await ask('PWRQSTN', 'PWR');
        let val = { online: true, power: false };
        if (pwr === '01') {
          const sli = await ask('SLIQSTN', 'SLI').catch(() => null);
          const mvl = await ask('MVLQSTN', 'MVL').catch(() => null);
          val = { online: true, power: true, input: sli, volume: mvl ? parseInt(mvl, 16) : null };
        }
        devCache = { at: Date.now(), val };
        return val;
      } catch { await sleep(250); } // un tropiezo suelto no significa que esté apagado
    }
    return { online: false, power: false };
  }
  async function powerOn() {
    const d = await device();
    if (!d.online) throw new Error('onkyo_sin_conexion');
    if (d.power) return d;
    devCache = null;
    await iscpDo(cfg, 'PWR01');
    for (let i = 0; i < 20; i++) { // el equipo tarda unos segundos en despertar
      await sleep(cfg.bootWaitMs);
      devCache = null;
      const n = await device();
      if (n.power) return n;
    }
    throw new Error('onkyo_no_enciende');
  }
  async function setVolume(level) {
    const v = Math.max(0, Math.min(cfg.maxVolume, Math.round(Number(level) || 0)));
    await iscpDo(cfg, `MVL${v.toString(16).toUpperCase().padStart(2, '0')}`);
    if (devCache?.val.power) devCache = { at: Date.now(), val: { ...devCache.val, volume: v } };
    return v;
  }

  // ---- cola y reproducción ----
  const S = { queue: [], index: -1, state: 'idle', startedAt: 0, pos: 0, dur: 0, sawPlaying: false, busy: null, err: null };
  let timer = null;
  const stopPolling = () => { if (timer) clearTimeout(timer); timer = null; };
  // Se pregunta cada ~2 s, y cada ~0,4 s en los últimos segundos de la canción: así el cambio a la siguiente casi no se nota.
  function startPolling() {
    if (timer) return;
    const near = S.state === 'playing' && S.dur && S.dur - S.pos < 8;
    timer = setTimeout(async () => {
      timer = null;
      try { await poll(); } catch { /* sigue */ }
      if (['playing', 'loading', 'paused'].includes(S.state) || S.busy) startPolling();
    }, near ? cfg.pollNearMs : cfg.pollMs);
    timer.unref?.();
  }

  async function loadAndPlay(i) {
    const t = S.queue[i];
    S.index = i; S.state = 'loading'; S.err = null;
    if (mp3) { await mp3.ensure(t.id); const n = S.queue[i + 1]; if (n) mp3.prefetch(n.id); } // el MP3 de esta (y la siguiente) debe existir antes de enviar el enlace
    const { url, mime } = mintUrl(t.id);
    S.index = i; S.pos = 0; S.dur = t.duration || 0; S.libDur = t.duration || 0; S.userPaused = false; S.sawPlaying = false; S.startedAt = Date.now(); S.state = 'loading'; S.err = null;
    // Se parte de un transporte limpio: el Onkyo real queda "trabado" (rechaza todo con 501) si se le cambia el enlace en pleno movimiento.
    // Si ya estaba detenido (pasó solo a la siguiente), no se pierde tiempo deteniéndolo otra vez.
    const t0 = Date.now();
    let st0 = '';
    try { st0 = tag(await av('GetTransportInfo'), 'CurrentTransportState'); } catch { /* se intenta igual */ }
    if (st0 !== 'STOPPED' && st0 !== 'NO_MEDIA_PRESENT') {
      try { await av('Stop'); } catch { /* ya estaba detenido */ }
      for (let k = 0; k < 8; k++) {
        let st = '';
        try { st = tag(await av('GetTransportInfo'), 'CurrentTransportState'); } catch { break; }
        if (st !== 'PLAYING' && st !== 'TRANSITIONING') break;
        await sleep(150);
      }
    }
    const t1 = Date.now();
    // Algunos equipos rechazan (error 501) ciertos metadatos: se prueba normal, luego estilo DLNA completo, y al final sin metadatos.
    const metas = [didl(t, url, mime), didl(t, url, mime, true), ''];
    let setErr;
    for (let k = 0; k < metas.length; k++) {
      try {
        await av('SetAVTransportURI', `<CurrentURI>${esc(url)}</CurrentURI><CurrentURIMetaData>${esc(metas[k])}</CurrentURIMetaData>`);
        setErr = null;
        if (k) log.info({ intento: k + 1 }, 'Onkyo: aceptó el enlace con otros metadatos');
        break;
      } catch (e) {
        setErr = e;
        log.warn({ err: e.message, intento: k + 1 }, 'Onkyo: rechazó el enlace');
        try { await av('Stop'); } catch { /* ya estaba detenido */ }
        await sleep(cfg.retryMs);
      }
    }
    if (setErr) throw setErr;
    const t2 = Date.now();
    let last;
    for (let k = 0; k < 4; k++) { // justo tras cambiar de entrada, el Onkyo a veces rechaza el primer Play
      try { await av('Play', '<Speed>1</Speed>'); last = null; break; } catch (e) { last = e; await sleep(cfg.retryMs); }
    }
    if (last) throw last;
    S.state = 'playing';
    log.info({ preparar_ms: t1 - t0, enlace_ms: t2 - t1, play_ms: Date.now() - t2 }, 'Onkyo: canción enviada');
    startPolling();
  }

  let posAt = 0;
  function applyInfo(info) {
    posAt = Date.now();
    const reported = hms(tag(info, 'RelTime'));
    // Justo después de saltar de minuto el Onkyo puede seguir diciendo la posición vieja unos instantes: no se la creemos.
    const expected = S.seekAt && Date.now() - S.seekAt < 4000 ? S.seekTo + (Date.now() - S.seekAt) / 1000 : null;
    if (expected == null || reported >= S.seekTo - 1) { S.pos = reported; if (expected != null) S.seekAt = 0; } // ya llegó al nuevo minuto
    else S.pos = Math.min(expected, S.dur || expected);
    const d = hms(tag(info, 'TrackDuration'));
    if (d) S.dur = d;
  }

  async function poll() {
    if (S.busy || !['playing', 'loading', 'paused'].includes(S.state)) { if (!S.busy && S.state === 'idle') stopPolling(); return; }
    let st = null;
    let info = null;
    try {
      st = tag(await av('GetTransportInfo'), 'CurrentTransportState');
      if (st === 'PLAYING') info = await av('GetPositionInfo');
    } catch { return; }
    if (info) applyInfo(info);
    if (st === 'PLAYING') { S.sawPlaying = true; S.state = 'playing'; return; }
    if (st === 'PAUSED_PLAYBACK') {
      // Algunos equipos quedan "en pausa" al terminar la canción. Si no la pausó una persona y estaba por terminar, cuenta como terminada.
      const endNear = S.sawPlaying && !S.userPaused && (S.dur || S.libDur || 1e9) - S.pos <= cfg.endSlackSec;
      if (!endNear) { S.state = 'paused'; return; }
      log.info({ pos: S.pos, dur: S.dur }, 'Onkyo: quedó en pausa al final de la canción: se pasa a la siguiente');
    }
    if (st === 'TRANSITIONING') return;
    // Detenido: ¿terminó la canción, o alguien lo paró?
    const total = S.dur || S.libDur || 1e9; // la duración que informa el Onkyo; si no informa, la de la biblioteca
    const finished = S.sawPlaying && (total < 1e9 ? S.pos >= total - cfg.endSlackSec : Date.now() - S.startedAt > 5000);
    if (!finished) log.info({ estado: st, pos: S.pos, dur: S.dur, biblioteca: S.libDur }, 'Onkyo: se detuvo sin llegar al final: se considera detenido a mano');
    if (!finished) {
      if (S.sawPlaying || Date.now() - S.startedAt > 20000) { S.state = 'stopped'; stopPolling(); }
      return;
    }
    if (S.index + 1 < S.queue.length) {
      S.busy = loadAndPlay(S.index + 1).catch((e) => { S.state = 'stopped'; S.err = e.message; log.warn({ err: e.message }, 'Onkyo: no pude pasar a la siguiente'); }).finally(() => { S.busy = null; });
    } else { S.state = 'stopped'; S.pos = S.dur; stopPolling(); }
  }

  const queueView = () => S.queue.map((t) => ({ id: t.id, title: t.title, artistName: t.artistName, albumId: t.albumId }));
  out.status = async () => {
    const d = await device();
    // La app pregunta seguido: la posición se lee fresca del Onkyo (no la de hace 2 s), así la barra y la pantalla de bloqueo no se desfasan.
    if (S.state === 'playing' && !S.busy && d.power && Date.now() - posAt > 600) {
      try { applyInfo(await av('GetPositionInfo')); } catch { /* se usa la última conocida */ }
    }
    const t = S.queue[S.index] || null;
    return {
      enabled: true, ...d, maxVolume: cfg.maxVolume, format: cfg.format,
      state: S.state, index: S.index, track: t && { id: t.id, title: t.title, artistName: t.artistName, albumId: t.albumId, duration: S.dur || t.duration },
      position: S.pos, queue: queueView(), error: S.err,
    };
  };

  // Si el trabajo (convertir el MP3, encender, enviar) tarda más de unos segundos, se responde igual con "cargando" y sigue en segundo plano.
  const FAST_MS = cfg.fastMs;
  const settle = (job) => Promise.race([job, sleep(FAST_MS)]);
  /** Espera un trabajo anterior; si sigue en curso pasado el límite, devuelve false (la orden nueva se ignora: ya está cargando). */
  const idle = async () => { if (S.busy) await settle(S.busy.catch(() => {})); return !S.busy; };
  const track = (job) => job.catch((e) => { S.state = 'stopped'; S.err = String(e.message || e).slice(0, 160); log.warn({ err: S.err }, 'Onkyo: no pude reproducir'); throw e; });

  out.play = async (userId, ids, index = 0) => {
    if (!(await idle())) return;
    const tracks = lib.byIds(userId, ids).filter((t) => t.ready);
    const order = new Map(ids.map((id, i) => [id, i]));
    tracks.sort((a, b) => order.get(a.id) - order.get(b.id));
    if (!tracks.length) throw new Error('sin_canciones');
    const startId = ids[Math.min(Math.max(index, 0), ids.length - 1)];
    const start = Math.max(0, tracks.findIndex((t) => t.id === startId));
    S.state = 'loading'; S.err = null; S.index = -1; S.queue = [];
    const job = track((async () => {
      const d = await powerOn();
      if (d.input !== '2B') { await iscpDo(cfg, 'SLI2B'); devCache = null; await sleep(cfg.inputWaitMs); }
      S.queue = tracks;
      await loadAndPlay(start);
    })()).finally(() => { if (S.busy === job) S.busy = null; });
    S.busy = job;
    job.catch(() => {}); // si ya respondimos, el error queda en el estado (error) y no como rechazo sin atender
    await settle(job);
  };

  async function startLoad(i) {
    const job = track(loadAndPlay(i)).finally(() => { if (S.busy === job) S.busy = null; });
    S.busy = job;
    job.catch(() => {});
    await settle(job);
  }

  out.control = async (action, arg) => {
    if (!(await idle())) return;
    if (!S.queue.length && action !== 'stop') throw new Error('nada_que_controlar');
    switch (action) {
      case 'pause': await av('Pause'); S.state = 'paused'; S.userPaused = true; break;
      case 'resume': await av('Play', '<Speed>1</Speed>'); S.state = 'playing'; S.userPaused = false; startPolling(); break;
      case 'stop': try { await av('Stop'); } catch { /* ya estaba detenido */ } S.state = 'stopped'; stopPolling(); break;
      case 'next': if (S.index + 1 < S.queue.length) await startLoad(S.index + 1); break;
      case 'prev': await startLoad(S.pos > 4 ? S.index : Math.max(0, S.index - 1)); break;
      case 'jump': break;
      case 'seek': {
        const to = Math.max(0, Math.min(Number(arg) || 0, (S.dur || 1e9) - 1));
        await av('Seek', `<Unit>REL_TIME</Unit><Target>${toHms(to)}</Target>`);
        S.pos = to; S.seekTo = to; S.seekAt = Date.now();
        break;
      }
      default: throw new Error('accion_invalida');
    }
  };
  out.jump = async (i) => {
    if (!(await idle())) return;
    if (!Number.isInteger(i) || i < 0 || i >= S.queue.length) throw new Error('accion_invalida');
    await startLoad(i);
  };
  /** Cambia la lista sin interrumpir lo que suena (agregar, quitar o "siguiente"): la canción actual debe seguir en la lista. */
  out.setQueue = async (userId, ids) => {
    const cur = S.queue[S.index];
    if (!cur) throw new Error('nada_que_controlar');
    const tracks = lib.byIds(userId, ids).filter((t) => t.ready);
    const pos = tracks.findIndex((t) => t.id === cur.id);
    if (pos < 0) throw new Error('accion_invalida');
    S.queue = tracks; S.index = pos;
    if (mp3 && tracks[pos + 1]) mp3.prefetch(tracks[pos + 1].id);
  };
  out.setVolume = setVolume;
  out.power = async (on) => {
    if (on) return powerOn();
    await iscpDo(cfg, 'PWR00');
    devCache = null;
    S.state = 'idle'; S.queue = []; S.index = -1; stopPolling();
    return { power: false };
  };
  out.prepare = () => mp3?.prepareAll();
  out.cleanup = () => mp3?.cleanup();
  out.close = () => { stopPolling(); lan.close(); lan.closeAllConnections?.(); };
  return out;
}
