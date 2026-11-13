import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { makeApp } from './helpers.js';
import { startFakeOnkyo } from './fake-onkyo.js';

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('tiempo agotado'); await sleep(50); } };

describe('Onkyo apagado por defecto', () => {
  let t;
  before(async () => { t = await makeApp(); });
  after(() => t.close());
  test('sin configurar: no hay botón ni rutas', async () => {
    const { cookie, res } = await t.login('admin@test.cl');
    assert.equal(res.json().user.onkyo, undefined); // el login no lo dice
    const A = t.api(cookie);
    assert.equal((await A('GET', '/api/me')).json().user.onkyo, false);
    assert.equal((await A('GET', '/api/onkyo')).statusCode, 404);
    assert.equal((await A('POST', '/api/onkyo/play', { ids: [1] })).statusCode, 404);
  });
});

describe('Onkyo (equipo simulado)', () => {
  let t, fake, lanPort, A, F, ids;
  before(async () => {
    fake = await startFakeOnkyo();
    lanPort = await freePort();
    t = await makeApp({
      ONKYO_IP: '127.0.0.1', ONKYO_LAN_IP: '127.0.0.1', ONKYO_LAN_PORT: String(lanPort), ONKYO_LAN_HOST: '127.0.0.1', ONKYO_FORMAT: 'm4a',
      ONKYO_EISCP_PORT: String(fake.eiscpPort), ONKYO_UPNP_PORT: String(fake.upnpPort),
      ONKYO_END_SLACK: '2', ONKYO_POLL_MS: '150', ONKYO_RETRY_MS: '50', ONKYO_BOOT_WAIT_MS: '100', ONKYO_INPUT_WAIT_MS: '50', ONKYO_MAX_VOLUME: '50',
    });
    await t.ctx.onkyo.listen();
    A = t.api((await t.login('admin@test.cl')).cookie);
    const friend = await t.login('amigo@test.cl');
    F = t.api(friend.cookie);
    await A('POST', `/api/admin/users/${friend.res.json().user.id}`, { status: 'active' });
    ids = (await A('GET', '/api/albums/1')).json().tracks.map((x) => x.id);
  });
  after(async () => { await t.close(); fake.close(); });

  test('solo el administrador lo controla', async () => {
    for (const [m, u, b] of [['GET', '/api/onkyo'], ['POST', '/api/onkyo/play', { ids }], ['POST', '/api/onkyo/volume', { level: 5 }], ['POST', '/api/onkyo/power', { on: true }], ['POST', '/api/onkyo/control', { action: 'stop' }]]) {
      assert.equal((await F(m, u, b)).statusCode, 403, u);
      assert.equal((await t.app.inject({ method: m, url: u, payload: b })).statusCode, 401, u);
    }
    assert.equal((await F('GET', '/api/me')).json().user.onkyo, false);
    assert.equal((await A('GET', '/api/me')).json().user.onkyo, true);
  });

  test('estado: equipo apagado', async () => {
    const s = (await A('GET', '/api/onkyo')).json();
    assert.equal(s.online, true);
    assert.equal(s.power, false);
    assert.equal(s.maxVolume, 50);
  });

  test('enviar: enciende, pone NET, y el Onkyo baja la canción por el enlace firmado', async () => {
    fake.av.rejectPlays = 1; // el primer Play lo rechaza, como pasa justo tras cambiar de entrada
    const r = await A('POST', '/api/onkyo/play', { ids, index: 1 });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(fake.dev.power, true);
    assert.equal(fake.dev.input, '2B');
    assert.equal(fake.log.filter((c) => c === 'AV:Play').length, 2); // reintentó
    const f = fake.av.fetched[0];
    assert.equal(f.status, 206);
    assert.equal(f.type, 'audio/mp4');
    assert.match(f.uri, new RegExp(`^http://127\\.0\\.0\\.1:${lanPort}/onkyo/[\\w-]+\\.[\\w-]+\\.m4a$`));
    const trackFile = fs.readdirSync(path.join(t.dataDir, 'audio'));
    assert.ok(f.bytes > 1000 && trackFile.length > 0);
    assert.match(decodeURIComponent(fake.av.meta.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')), /object\.item\.audioItem\.musicTrack/);
    const s = r.json();
    assert.equal(s.state, 'playing');
    assert.equal(s.index, ids.indexOf(s.track.id));
    assert.equal(s.track.id, ids[1]);
  });

  test('el enlace falso, vencido o ajeno no sirve nada', async () => {
    const good = new URL(fake.av.uri);
    const get = (p, init) => fetch(`http://127.0.0.1:${lanPort}${p}`, init);
    assert.equal((await get(good.pathname)).status, 200); // sin Range responde completo
    const [payload, sig, ext] = good.pathname.replace('/onkyo/', '').split('.');
    assert.equal((await get(`/onkyo/${payload}.${'A'.repeat(32)}.${ext}`)).status, 403);
    const other = Buffer.from(JSON.stringify({ t: 2, e: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
    assert.equal((await get(`/onkyo/${other}.${sig}.${ext}`)).status, 403); // firma de otra canción
    const exp = Buffer.from(JSON.stringify({ t: ids[0], e: 5 })).toString('base64url');
    assert.equal((await get(`/onkyo/${exp}.${sig}.${ext}`)).status, 403);
    assert.equal((await get('/api/stream/1')).status, 404); // el puerto del Onkyo no es la app
    assert.equal((await get('/')).status, 404);
    assert.equal((await get('/onkyo/../../etc/passwd')).status, 404);
    assert.equal((await get(good.pathname, { method: 'POST' })).status, 405);
    assert.equal((await get(good.pathname, { headers: { range: 'bytes=999999999-' } })).status, 416);
    assert.equal((await get(`/onkyo/${payload}.${sig}.wav`)).status, 403); // el formato también va firmado
  });

  test('volumen: respeta el tope de seguridad', async () => {
    assert.equal((await A('POST', '/api/onkyo/volume', { level: 200 })).json().volume, 50);
    assert.equal(fake.dev.volume, 50);
    assert.equal((await A('POST', '/api/onkyo/volume', { level: 20 })).json().volume, 20);
    assert.equal((await A('POST', '/api/onkyo/volume', { level: -5 })).json().volume, 0);
    assert.equal((await A('POST', '/api/onkyo/volume', { level: 'alto' })).statusCode, 400);
  });

  test('subir el volumen mientras se consulta el estado no hace que parezca desconectado', async () => {
    const jobs = [];
    for (let i = 0; i < 12; i++) {
      jobs.push(A('GET', '/api/onkyo').then((r) => r.json()));
      jobs.push(A('POST', '/api/onkyo/volume', { level: 10 + i }).then((r) => r.json()));
    }
    const res = await Promise.all(jobs);
    assert.ok(res.filter((r) => 'online' in r).every((r) => r.online === true), 'nunca debe salir "no responde"');
    assert.equal(fake.dev.volume, 21);
    assert.equal((await A('POST', '/api/onkyo/volume', { level: 20 })).json().volume, 20);
  });

  test('saltar de minuto: la barra no se devuelve aunque el Onkyo tarde en informar', async () => {
    await A('POST', '/api/onkyo/play', { ids: ids.slice(0, 3), index: 0 });
    await until(async () => (await A('GET', '/api/onkyo')).json().position >= 1); // ya informó la duración real
    fake.av.staleSeek = true; // acepta el salto pero sigue diciendo la posición vieja
    const r = await A('POST', '/api/onkyo/control', { action: 'seek', position: 5 });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(fake.av.seeks.at(-1), '0:00:05');
    assert.equal(r.json().position, 5);
    await sleep(500); // varios sondeos con la posición vieja (~0)
    const s = (await A('GET', '/api/onkyo')).json();
    assert.ok(s.position >= 5, `la posición no debe volver atrás: ${s.position}`);
    fake.av.staleSeek = false;
    // saltar con el Onkyo funcionando normal
    await A('POST', '/api/onkyo/control', { action: 'seek', position: 4 });
    await until(async () => (await A('GET', '/api/onkyo')).json().position >= 4);
    assert.equal((await A('POST', '/api/onkyo/control', { action: 'seek', position: 'a' })).statusCode, 400);
    // si el Onkyo no permite saltar, se dice
    fake.av.noSeek = true;
    const bad = await A('POST', '/api/onkyo/control', { action: 'seek', position: 3 });
    assert.equal(bad.statusCode, 502);
    assert.equal(bad.json().error, 'onkyo_rechazo');
    fake.av.noSeek = false;
  });

  test('pausa, seguir y saltar a otra de la cola', async () => {
    assert.equal((await A('POST', '/api/onkyo/control', { action: 'pause' })).json().state, 'paused');
    assert.equal(fake.av.state, 'PAUSED_PLAYBACK');
    assert.equal((await A('POST', '/api/onkyo/control', { action: 'resume' })).json().state, 'playing');
    const j = await A('POST', '/api/onkyo/control', { action: 'jump', index: 0 });
    assert.equal(j.json().track.id, ids[0]);
    assert.equal((await A('POST', '/api/onkyo/control', { action: 'jump', index: 999 })).statusCode, 400);
    assert.equal((await A('POST', '/api/onkyo/control', { action: 'volar' })).statusCode, 400);
  });

  test('al terminar una canción pasa sola a la siguiente, y al final se detiene', async () => {
    await A('POST', '/api/onkyo/play', { ids: ids.slice(0, 3), index: 0 });
    const before = fake.av.fetched.length;
    await until(async () => (await A('GET', '/api/onkyo')).json().index === 2, 25000);
    assert.ok(fake.av.fetched.length >= before + 2);
    await until(async () => (await A('GET', '/api/onkyo')).json().state === 'stopped', 20000);
  });

  test('si alguien lo detiene a mitad de canción, no salta a la siguiente', async () => {
    await A('POST', '/api/onkyo/play', { ids: ids.slice(0, 3), index: 0 });
    await until(async () => (await A('GET', '/api/onkyo')).json().position >= 1); // ya sonó un rato
    fake.av.state = 'STOPPED'; // alguien apretó stop en el control del Onkyo
    fake.av.startedAt = Date.now();
    await sleep(900);
    const s = (await A('GET', '/api/onkyo')).json();
    assert.equal(s.state, 'stopped');
    assert.equal(s.index, 0);
  });

  test('datos malos y apagar', async () => {
    assert.equal((await A('POST', '/api/onkyo/play', { ids: [] })).statusCode, 400);
    assert.equal((await A('POST', '/api/onkyo/play', { ids: ['a', -1, 1.5] })).statusCode, 400);
    assert.equal((await A('POST', '/api/onkyo/play', { ids: [999999] })).statusCode, 400); // no existe
    const r = await A('POST', '/api/onkyo/power', { on: false });
    assert.equal(r.statusCode, 200);
    assert.equal(fake.dev.power, false);
    assert.equal(r.json().queue.length, 0);
  });

  test('Onkyo desconectado: error claro, sin colgarse', async () => {
    fake.close();
    await sleep(1700); // vence la memoria del último estado
    const s = (await A('GET', '/api/onkyo')).json();
    assert.equal(s.online, false);
    const r = await A('POST', '/api/onkyo/play', { ids });
    assert.equal(r.statusCode, 502);
    assert.equal(r.json().error, 'onkyo_sin_conexion');
  });
});

describe('Onkyo con WAV originales', () => {
  let t, fake, A, lanPort;
  before(async () => {
    fake = await startFakeOnkyo();
    lanPort = await freePort();
    t = await makeApp({
      ONKYO_IP: '127.0.0.1', ONKYO_LAN_IP: '127.0.0.1', ONKYO_LAN_PORT: String(lanPort), ONKYO_LAN_HOST: '127.0.0.1', ONKYO_FORMAT: 'wav',
      ONKYO_EISCP_PORT: String(fake.eiscpPort), ONKYO_UPNP_PORT: String(fake.upnpPort), ONKYO_POLL_MS: '150', ONKYO_BOOT_WAIT_MS: '100', ONKYO_INPUT_WAIT_MS: '50',
    });
    await t.ctx.onkyo.listen();
    A = t.api((await t.login('admin@test.cl')).cookie);
  });
  after(async () => { await t.close(); fake.close(); });
  test('manda el WAV original, sin tocarlo', async () => {
    const ids = (await A('GET', '/api/albums/1')).json().tracks.map((x) => x.id);
    assert.equal((await A('POST', '/api/onkyo/play', { ids })).statusCode, 200);
    const f = fake.av.fetched[0];
    assert.match(f.uri, /\.wav$/);
    assert.equal(f.type, 'audio/wav');
    assert.ok(f.bytes > 100000);
  });
});

describe('Onkyo con MP3 (formato por defecto)', () => {
  let t, fake, A, lanPort;
  before(async () => {
    fake = await startFakeOnkyo();
    lanPort = await freePort();
    t = await makeApp({
      ONKYO_IP: '127.0.0.1', ONKYO_LAN_IP: '127.0.0.1', ONKYO_LAN_PORT: String(lanPort), ONKYO_LAN_HOST: '127.0.0.1',
      ONKYO_EISCP_PORT: String(fake.eiscpPort), ONKYO_UPNP_PORT: String(fake.upnpPort), ONKYO_POLL_MS: '150', ONKYO_BOOT_WAIT_MS: '100', ONKYO_INPUT_WAIT_MS: '50',
    });
    await t.ctx.onkyo.listen();
    A = t.api((await t.login('admin@test.cl')).cookie);
  });
  after(async () => { await t.close(); fake.close(); });

  test('crea un MP3 de verdad (320k, estéreo, 44,1 kHz), lo manda con el tipo correcto y prepara el siguiente', async () => {
    assert.equal(t.config.onkyo.format, 'mp3');
    const ids = (await A('GET', '/api/albums/1')).json().tracks.map((x) => x.id);
    const r = await A('POST', '/api/onkyo/play', { ids });
    assert.equal(r.statusCode, 200, r.body);
    const f = fake.av.fetched[0];
    assert.match(f.uri, /\.mp3$/);
    assert.equal(f.type, 'audio/mpeg');
    assert.equal(f.status, 206);
    const dir = path.join(t.dataDir, 'onkyo-mp3');
    const first = fs.readdirSync(dir).filter((x) => x.endsWith('.mp3'));
    assert.ok(first.length >= 1);
    const probe = JSON.parse((await import('node:child_process')).execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,bit_rate', '-of', 'json', path.join(dir, first[0])]).toString());
    assert.equal(probe.streams[0].codec_name, 'mp3');
    assert.equal(probe.streams[0].sample_rate, '44100');
    assert.equal(probe.streams[0].channels, 2);
    assert.ok(Number(probe.streams[0].bit_rate) > 300000);
    assert.ok(f.bytes > 5000);
    // la siguiente canción de la cola ya se está preparando
    await until(() => fs.readdirSync(dir).filter((x) => x.endsWith('.mp3')).length >= 2, 15000);
    // el enlace de un MP3 no sirve con otra extensión
    const good = new URL(fake.av.uri);
    assert.equal((await fetch(`http://127.0.0.1:${lanPort}${good.pathname.replace(/\.mp3$/, '.m4a')}`)).status, 403);
  });
});

describe('Onkyo: preparar el MP3 no cuelga la petición, y los fallos se explican', () => {
  let t, fake, A, lanPort, ids;
  before(async () => {
    fake = await startFakeOnkyo();
    lanPort = await freePort();
    t = await makeApp({
      ONKYO_IP: '127.0.0.1', ONKYO_LAN_IP: '127.0.0.1', ONKYO_LAN_PORT: String(lanPort), ONKYO_LAN_HOST: '127.0.0.1', ONKYO_FAST_MS: '1',
      ONKYO_EISCP_PORT: String(fake.eiscpPort), ONKYO_UPNP_PORT: String(fake.upnpPort), ONKYO_POLL_MS: '150', ONKYO_BOOT_WAIT_MS: '100', ONKYO_INPUT_WAIT_MS: '50', ONKYO_RETRY_MS: '50',
    });
    await t.ctx.onkyo.listen();
    A = t.api((await t.login('admin@test.cl')).cookie);
    ids = (await A('GET', '/api/albums/1')).json().tracks.map((x) => x.id);
  });
  after(async () => { await t.close(); fake.close(); });

  test('si tarda, responde "cargando" enseguida y termina sonando en segundo plano', async () => {
    const r = await A('POST', '/api/onkyo/play', { ids });
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(['loading', 'playing'].includes(r.json().state));
    await until(async () => (await A('GET', '/api/onkyo')).json().state === 'playing', 15000);
    assert.equal(fake.av.fetched[0].type, 'audio/mpeg');
    // pedir "siguiente" mientras todavía está cargando no se pisa con la carga anterior
    const n = await A('POST', '/api/onkyo/control', { action: 'next' });
    assert.equal(n.statusCode, 200);
    await until(async () => { const s = (await A('GET', '/api/onkyo')).json(); return s.index === 1 && s.state === 'playing'; }, 15000);
  });

  test('si el Onkyo rechaza el enlace (error 501), reintenta con otros metadatos hasta que lo acepta', async () => {
    await A('POST', '/api/onkyo/control', { action: 'stop' });
    fake.av.metas.length = 0;
    fake.av.rejectSets = 2;
    const r = await A('POST', '/api/onkyo/play', { ids: [ids[1]] });
    assert.equal(r.statusCode, 200, r.body);
    await until(async () => (await A('GET', '/api/onkyo')).json().state === 'playing', 15000);
    assert.equal(fake.av.metas.length, 3);
    const un = (x) => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    assert.match(un(fake.av.metas[0]), /protocolInfo="http-get:\*:audio\/mpeg:\*"/);
    assert.match(un(fake.av.metas[1]), /DLNA\.ORG_PN=MP3/);
    assert.equal(fake.av.metas[2], '');
  });

  test('si no se puede preparar el MP3, la app lo dice (no solo "problema del servidor")', async () => {
    t.ctx.db.prepare("UPDATE tracks SET src_rel='no-existe.wav' WHERE id=?").run(ids[0]);
    const dir = path.join(t.dataDir, 'onkyo-mp3');
    for (const f of fs.readdirSync(dir)) if (f.startsWith(`${ids[0]}-`)) fs.unlinkSync(path.join(dir, f)); // sin copia ya hecha
    await A('POST', '/api/onkyo/control', { action: 'stop' });
    const r = await A('POST', '/api/onkyo/play', { ids: [ids[0]] });
    let s;
    if (r.statusCode === 200) s = (await until(async () => { const x = (await A('GET', '/api/onkyo')).json(); return x.state === 'stopped' && x.error ? x : null; }, 8000));
    else { assert.equal(r.statusCode, 502); assert.equal(r.json().error, 'onkyo_mp3_fallo'); assert.ok(r.json().detail); return; }
    assert.ok(s.error.length > 3);
  });
});
