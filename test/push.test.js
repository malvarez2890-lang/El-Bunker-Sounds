import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeApp } from './helpers.js';
import crypto from 'node:crypto';
import { generateRequestDetails } from 'web-push';
import { endpointAllowed } from '../server/push.js';

const KEYS = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) };
const sub = (n) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/dispositivo-${n}`, keys: KEYS });

describe('quién puede recibir avisos (destinos permitidos)', () => {
  test('solo los servicios de notificaciones de los navegadores', () => {
    assert.equal(endpointAllowed('https://fcm.googleapis.com/fcm/send/abc'), true);
    assert.equal(endpointAllowed('https://web.push.apple.com/QAbc'), true);
    assert.equal(endpointAllowed('https://updates.push.services.mozilla.com/wpush/v2/abc'), true);
    assert.equal(endpointAllowed('https://wns2-par02p.notify.windows.com/w/?token=x'), true);
    for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://192.168.100.10/x', 'http://192.168.100.10:443/x', 'https://fcm.googleapis.com:8443/x', 'ftp://web.push.apple.com/x', 'no es un enlace', '']) {
      assert.equal(endpointAllowed(bad), false, bad);
    }
  });
});

describe('el aviso real (cifrado y firma) se arma bien', () => {
  test('con una suscripción de verdad: cabeceras VAPID, cifrado aes128gcm y destino correcto', async () => {
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const sub = { endpoint: 'https://web.push.apple.com/QAbc123', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
    const vapid = (await import('web-push')).generateVAPIDKeys();
    const d = generateRequestDetails(sub, JSON.stringify({ title: 'Hola', body: 'Mundo' }), { vapidDetails: { subject: 'mailto:no-responder@example.com', publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 3600 });
    assert.equal(d.endpoint, sub.endpoint);
    assert.equal(d.method, 'POST');
    assert.match(d.headers.Authorization, /^vapid t=.+, k=.+$/);
    assert.equal(d.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(d.headers.TTL, 3600);
    assert.ok(Buffer.isBuffer(d.body) && d.body.length > 40);
  });
});

describe('avisos al celular', () => {
  let t, A, F, P, calls, adminId, friendId, failWith;
  before(async () => {
    calls = [];
    failWith = new Map();
    t = await makeApp({ pushSender: async (s, payload) => { calls.push({ endpoint: s.endpoint, payload: JSON.parse(payload) }); const f = failWith.get(s.endpoint); if (f) throw Object.assign(new Error('x'), { statusCode: f }); } });
    const admin = await t.login('admin@test.cl');
    adminId = admin.res.json().user.id;
    A = t.api(admin.cookie);
    const friend = await t.login('amigo@test.cl');
    friendId = friend.res.json().user.id;
    await A('POST', `/api/admin/users/${friendId}`, { status: 'active' });
    F = t.api(friend.cookie);
    const pending = await t.login('pendiente@test.cl');
    P = t.api(pending.cookie);
  });
  after(() => t.close());

  test('configuración: clave pública para el celular; los pendientes no entran', async () => {
    const r = (await F('GET', '/api/push/config')).json();
    assert.match(r.publicKey, /^[A-Za-z0-9_-]{80,100}$/);
    assert.equal(r.subscribed, false);
    assert.equal((await P('GET', '/api/push/config')).statusCode, 403);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/push/config' })).statusCode, 401);
    assert.equal(fs.existsSync(path.join(t.dataDir, 'vapid.json')), true);
  });

  test('activar: se rechazan destinos raros y claves malas; se acepta uno bueno', async () => {
    assert.equal((await F('POST', '/api/push/subscribe', { endpoint: 'https://192.168.100.201/x', keys: KEYS })).statusCode, 400);
    assert.equal((await F('POST', '/api/push/subscribe', { endpoint: 'http://fcm.googleapis.com/x', keys: KEYS })).statusCode, 400);
    assert.equal((await F('POST', '/api/push/subscribe', { endpoint: sub(1).endpoint, keys: { p256dh: 'corta', auth: 'x' } })).statusCode, 400);
    assert.equal((await F('POST', '/api/push/subscribe', {})).statusCode, 400);
    assert.equal((await P('POST', '/api/push/subscribe', sub(9))).statusCode, 403);
    assert.equal((await F('POST', '/api/push/subscribe', sub(1))).statusCode, 200);
    assert.equal((await F('POST', '/api/push/subscribe', sub(1))).statusCode, 200); // repetir no duplica
    assert.equal((await F('GET', '/api/push/config')).json().subscribed, true);
    assert.equal(t.ctx.push.stats().devices, 1);
    assert.equal((await A('POST', '/api/push/subscribe', sub(2))).statusCode, 200);
    assert.equal(t.ctx.push.stats().devices, 2);
  });

  test('solo el administrador manda avisos o cambia los ajustes', async () => {
    for (const [m, u, b] of [['GET', '/api/admin/push'], ['POST', '/api/admin/push/settings', { autoNewMusic: true }], ['POST', '/api/admin/push/test', {}]]) {
      assert.equal((await F(m, u, b)).statusCode, 403, u);
    }
  });

  test('"probar en mi celular" avisa solo al administrador', async () => {
    calls.length = 0;
    const r = (await A('POST', '/api/admin/push/test', {})).json().result;
    assert.equal(r.sent, 1);
    assert.deepEqual(calls.map((c) => c.endpoint), [sub(2).endpoint]);
  });

  test('una novedad con "avisar" llega a todos los que activaron los avisos (no a los bloqueados)', async () => {
    calls.length = 0;
    const albumId = (await A('GET', '/api/albums')).json().albums[0].id;
    const r = await A('POST', '/api/admin/news', { title: 'Próximo lanzamiento', body: 'Cuatro singles', albumId, notify: true });
    assert.equal(r.json().push.sent, 2);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].payload.title, 'Próximo lanzamiento');
    assert.equal(calls[0].payload.url, `/#/album/${albumId}`);
    // sin "avisar" o oculta, no se manda nada
    calls.length = 0;
    await A('POST', '/api/admin/news', { title: 'Sin aviso' });
    await A('POST', '/api/admin/news', { title: 'Oculta', notify: true, active: false });
    assert.equal(calls.length, 0);
    // un amigo bloqueado deja de recibir
    await A('POST', `/api/admin/users/${friendId}`, { status: 'blocked' });
    await A('POST', '/api/admin/news', { title: 'Otra', notify: true });
    assert.deepEqual(calls.map((c) => c.endpoint), [sub(2).endpoint]);
    await A('POST', `/api/admin/users/${friendId}`, { status: 'active' });
  });

  test('si el celular ya no existe (410), se borra solo; un fallo cualquiera no lo borra', async () => {
    failWith.set(sub(1).endpoint, 410);
    const r = (await A('POST', '/api/admin/news', { title: 'Prueba 410', notify: true })).json().push;
    assert.equal(r.removed, 1);
    assert.equal(r.sent, 1);
    assert.equal(t.ctx.push.stats().devices, 1);
    failWith.set(sub(2).endpoint, 500);
    const r2 = (await A('POST', '/api/admin/news', { title: 'Prueba 500', notify: true })).json().push;
    assert.equal(r2.failed, 1);
    assert.equal(t.ctx.push.stats().devices, 1);
    failWith.clear();
  });

  test('desactivar borra el celular', async () => {
    assert.equal((await A('POST', '/api/push/unsubscribe', { endpoint: sub(2).endpoint })).statusCode, 200);
    assert.equal(t.ctx.push.stats().devices, 0);
  });
});

describe('aviso automático de música nueva', () => {
  let t, dir, A, calls, album;
  const wav = (name, hz) => execFileSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=1`, path.join(album, name)]);
  before(async () => {
    calls = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebs-nueva-'));
    album = path.join(dir, 'Artista', 'PIÙ VELOCE', 'Albums', '05. La Vita È Un Gioco');
    fs.mkdirSync(album, { recursive: true });
    wav('03. Tutto Sotto Controllo.wav', 440);
    t = await makeApp({ MUSIC_DIR: dir, pushSender: async (s, payload) => { calls.push(JSON.parse(payload)); } });
    A = t.api((await t.login('admin@test.cl')).cookie);
    await A('POST', '/api/push/subscribe', sub(1));
  });
  after(() => t.close());

  test('apagado por defecto: llegan canciones y no se avisa', async () => {
    wav('04. Telefono Occupato.wav', 520);
    await t.ctx.library.scan(); await t.ctx.transcoder.whenIdle(); await t.ctx.push.announceNewMusic();
    assert.equal(calls.length, 0);
  });

  test('al activarlo, lo que ya existe NO se avisa; lo nuevo se avisa una sola vez', async () => {
    assert.equal((await A('POST', '/api/admin/push/settings', { autoNewMusic: true })).json().autoNewMusic, true);
    await t.ctx.push.announceNewMusic();
    assert.equal(calls.length, 0, 'nada de lo viejo');
    wav('05. Noi Siamo.wav', 600);
    await t.ctx.library.scan();
    await t.ctx.transcoder.whenIdle();
    await t.ctx.push.announceNewMusic();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].title, 'Música nueva');
    assert.match(calls[0].body, /PIÙ VELOCE · La Vita È Un Gioco \(1 canción nueva\)/);
    assert.match(calls[0].url, /^\/#\/album\/\d+$/);
    await t.ctx.push.announceNewMusic();
    await t.ctx.library.scan();
    assert.equal(calls.length, 1, 'no se repite');
  });

  test('varias canciones nuevas de un álbum se avisan juntas', async () => {
    wav('06. Un Gettone Ancora.wav', 700); wav('08. Birra Elegante.wav', 800);
    await t.ctx.library.scan(); await t.ctx.transcoder.whenIdle(); await t.ctx.push.announceNewMusic();
    assert.equal(calls.length, 2);
    assert.match(calls[1].body, /\(2 canciones nuevas\)/);
  });

  test('se puede apagar de nuevo', async () => {
    assert.equal((await A('POST', '/api/admin/push/settings', { autoNewMusic: false })).json().autoNewMusic, false);
    assert.equal((await A('POST', '/api/admin/push/settings', { autoNewMusic: 'si' })).statusCode, 400);
  });
});

describe('lanzamientos: aviso automático por correo y celular cuando un álbum queda completo', () => {
  let t, dir, album, calls;
  const wav = (name, hz) => execFileSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=1`, path.join(album, name)]);
  const correos = () => { const d = path.join(t.dataDir, 'outbox'); return fs.existsSync(d) ? fs.readdirSync(d).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))).filter((m) => /Ya salió/i.test(m.subject)) : []; };
  before(async () => {
    calls = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebs-lanz-'));
    const viejo = path.join(dir, 'Artista', 'PIÙ VELOCE', 'Albums', '01. Viejo');
    fs.mkdirSync(viejo, { recursive: true });
    execFileSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1', path.join(viejo, '01. Uno.wav')]);
    album = path.join(dir, 'Artista', 'PIÙ VELOCE', 'Albums', '05. Nuevo Disco');
    fs.mkdirSync(album, { recursive: true });
    t = await makeApp({ MUSIC_DIR: dir, LAUNCH_HOURS: '0-24', LAUNCH_MAIL_PAUSE_MS: '0', pushSender: async (s, payload) => { calls.push(JSON.parse(payload)); } });
  });
  after(() => { delete process.env.EBS_FAKE_TODAY; return t.close(); });

  test('lo que ya existía no se avisa; un álbum con fecha futura espera; el día de salida se avisa una sola vez, solo a los activos', async () => {
    const A = t.api((await t.login('admin@test.cl')).cookie);
    await A('POST', '/api/push/subscribe', sub(1));
    const ts = Math.floor(Date.now() / 1000);
    for (const [e, st] of [['ana@test.cl', 'active'], ['beto@test.cl', 'pending'], ['caro@test.cl', 'blocked']]) t.ctx.db.prepare('INSERT INTO users(email,name,status,created_at) VALUES(?,?,?,?)').run(e, e.split('@')[0], st, ts);
    assert.deepEqual(await t.ctx.launch.check(), [], 'el álbum viejo ya estaba: no se avisa');

    process.env.EBS_FAKE_TODAY = '2026-11-20';
    fs.writeFileSync(path.join(album, 'TRACKLIST.txt'), 'Lanzamiento: 21 de noviembre de 2026\nDisponibles: 1\n01. Uno\n02. Dos\n03. Tres\n');
    wav('01. Uno.wav', 400); wav('02. Dos.wav', 500); wav('03. Tres.wav', 600);
    await t.ctx.library.scan(); await t.ctx.transcoder.whenIdle();
    assert.deepEqual(await t.ctx.launch.check(), [], 'con canciones programadas todavía no es un lanzamiento');
    assert.equal(correos().length, 0);

    process.env.EBS_FAKE_TODAY = '2026-11-21';
    assert.deepEqual(await t.ctx.launch.check(), ['Nuevo Disco']);
    const mails = correos();
    assert.deepEqual(mails.map((m) => m.to).sort(), ['admin@test.cl', 'ana@test.cl'], 'solo los activos, un correo cada uno');
    assert.ok(calls.some((c) => /Ya salió Nuevo Disco/.test(c.title) && /3 canciones/.test(c.body) && /^\/#\/album\/\d+$/.test(c.url)), 'y también el aviso al celular');
    assert.deepEqual(await t.ctx.launch.check(), [], 'no se repite');
    await t.ctx.library.scan();
    assert.deepEqual(await t.ctx.launch.check(), []);
    assert.equal(correos().length, 2);
  });

  test('de madrugada espera, y se puede apagar desde Administración', async () => {
    const A = t.api((await t.login('admin@test.cl')).cookie);
    const horas = t.config.launch.hours;
    t.config.launch.hours = [3, 3]; // fuera de horario (antes de escanear, para que nada se adelante)
    const album2 = path.join(dir, 'Artista', 'PIÙ VELOCE', 'Albums', '06. Otro');
    fs.mkdirSync(album2, { recursive: true });
    execFileSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=700:duration=1', path.join(album2, '01. Solo.wav')]);
    await t.ctx.library.scan(); await t.ctx.transcoder.whenIdle();
    assert.deepEqual(await t.ctx.launch.check(), [], 'de madrugada no se avisa');
    assert.equal((await A('POST', '/api/admin/push/settings', { autoLaunch: false })).json().autoLaunch, false);
    t.config.launch.hours = horas;
    assert.deepEqual(await t.ctx.launch.check(), [], 'apagado');
    assert.equal((await A('POST', '/api/admin/push/settings', { autoLaunch: true })).json().autoLaunch, true);
    assert.deepEqual(await t.ctx.launch.check(), ['Otro'], 'en horario y encendido, sale lo que quedó pendiente');
  });
});
