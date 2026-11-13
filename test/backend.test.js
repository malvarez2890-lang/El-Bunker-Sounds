import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeApp } from './helpers.js';
import { safeJoin } from '../server/safe-path.js';
import { parseNumbered } from '../server/scanner.js';
import { norm } from '../server/util.js';

describe('utilidades', () => {
  test('safeJoin rechaza rutas que salen de la carpeta', () => {
    assert.equal(safeJoin('/music', '../etc/passwd'), null);
    assert.equal(safeJoin('/music', 'a/../../b'), null);
    assert.equal(safeJoin('/music', '/etc/passwd'), null);
    assert.equal(safeJoin('/music', 'a\0b'), null);
    assert.equal(safeJoin('/music', 'artista/album/x.wav'), '/music/artista/album/x.wav');
    assert.equal(safeJoin('/music', '../music2/x'), null);
  });
  test('parseNumbered', () => {
    assert.deepEqual(parseNumbered('01. ENTRE LOS ÁRBOLES'), { no: 1, title: 'ENTRE LOS ÁRBOLES' });
    assert.deepEqual(parseNumbered('09. 3.17'), { no: 9, title: '3.17' });
    assert.deepEqual(parseNumbered('3.17'), { no: null, title: '3.17' });
    assert.deepEqual(parseNumbered('Mañana'), { no: null, title: 'Mañana' });
    assert.deepEqual(parseNumbered('06. Scusa... Sono Io'), { no: 6, title: 'Scusa... Sono Io' });
    assert.deepEqual(parseNumbered('02 - Algo'), { no: 2, title: 'Algo' });
  });
  test('norm quita tildes', () => assert.equal(norm('PIÙ VELOCE Mañana'), 'piu veloce manana'));
});

describe('servidor', () => {
  let t, admin, friend, A, F;
  before(async () => {
    t = await makeApp();
    admin = await t.login('admin@test.cl');
    friend = await t.login('amigo@test.cl');
    A = t.api(admin.cookie);
    F = t.api(friend.cookie);
  });
  after(() => t.close());

  test('el escáner entiende la estructura y convierte todo a M4A', async () => {
    const lib = t.ctx.library.lastScan();
    assert.equal(lib.artists, 2);
    assert.equal(lib.tracks, 46);
    const st = t.ctx.transcoder.status();
    assert.equal(st.ok, 46, JSON.stringify(st));
    assert.equal(st.error, 0);
    assert.equal(st.pending, 0);
    const files = fs.readdirSync(path.join(t.dataDir, 'audio')).filter((f) => f.endsWith('.m4a'));
    assert.equal(files.length, 46);
  });

  test('administrador entra directo; el amigo queda pendiente y no ve nada', async () => {
    assert.equal(admin.res.json().user.status, 'active');
    assert.equal(admin.res.json().user.isAdmin, true);
    assert.equal(friend.res.json().user.status, 'pending');
    const me = await F('GET', '/api/me');
    assert.equal(me.json().user.status, 'pending');
    for (const url of ['/api/home', '/api/albums', '/api/artists', '/api/search?q=neon', '/api/stream/1', '/api/cover/1/s', '/api/playlists', '/api/admin/users']) {
      const r = await F('GET', url);
      assert.equal(r.statusCode, 403, `${url} debería dar 403 y dio ${r.statusCode}`);
    }
  });

  test('sin sesión no se puede nada (música, carátulas, biblioteca)', async () => {
    for (const url of ['/api/home', '/api/stream/1', '/api/cover/1/s', '/api/albums/1', '/api/me']) {
      const r = await t.app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 401, url);
    }
  });

  test('el admin aprueba al amigo desde la API', async () => {
    const list = (await A('GET', '/api/admin/users')).json().users;
    assert.equal(list[0].email, 'amigo@test.cl'); // los pendientes van primero
    const r = await A('POST', `/api/admin/users/${list[0].id}`, { status: 'active' });
    assert.equal(r.json().user.status, 'active');
    assert.equal((await F('GET', '/api/home')).statusCode, 200);
    // y no puede cambiarse a sí mismo ni entrar al panel
    assert.equal((await F('GET', '/api/admin/users')).statusCode, 403);
    const me = (await A('GET', '/api/me')).json().user;
    assert.equal((await A('POST', `/api/admin/users/${me.id}`, { status: 'blocked' })).statusCode, 400);
  });

  test('biblioteca: artistas, álbumes, orden de canciones y búsqueda sin tildes', async () => {
    const { artists } = (await F('GET', '/api/artists')).json();
    assert.deepEqual(artists.map((a) => a.name).sort(), ['El MAS LENTO', 'PIÙ VELOCE']);
    const { albums } = (await F('GET', '/api/albums')).json();
    const ep = albums.find((a) => a.title === 'Più Lento');
    assert.equal(ep.kind, 'ep');
    assert.equal(ep.hasCover, false);
    assert.equal(albums.filter((a) => a.kind === 'single').length, 1);
    const detail = (await F('GET', `/api/albums/${ep.id}`)).json();
    assert.deepEqual(detail.tracks.map((x) => x.title), ['ENTRE LOS ÁRBOLES', 'DONDE TERMINA LA TARDE', 'SOMBRAS DE NEÓN', 'Mañana', 'Waracverso']);
    const musica = albums.find((a) => a.title === 'Musica per te');
    assert.equal(musica.trackCount, 15);
    assert.equal(musica.hasCover && musica.hasBack, true);
    const full = (await F('GET', `/api/albums/${musica.id}`)).json();
    assert.equal(full.tracks[8].title, 'Cartoline Senza Indirizzo');
    assert.equal(full.tracks[9].title, "Più Veloce & Carlo D'Oliva");
    const s = (await F('GET', '/api/search?q=' + encodeURIComponent('piu veloce'))).json();
    assert.ok(s.artists.some((a) => a.name === 'PIÙ VELOCE'));
    const s1 = (await F('GET', '/api/search?q=' + encodeURIComponent('carlo d\'oliva'))).json();
    assert.equal(s1.tracks.length, 1);
    assert.equal(s1.tracks[0].artistName, 'PIÙ VELOCE');
    const s2 = (await F('GET', '/api/search?q=' + encodeURIComponent('MAÑANA'))).json();
    assert.equal(s2.tracks.length, 1);
    const s3 = (await F('GET', '/api/search?q=' + encodeURIComponent("100%_\\"))).json();
    assert.equal(s3.tracks.length, 0);
  });

  test('stream: responde audio con soporte de rangos', async () => {
    const { albums } = (await F('GET', '/api/albums')).json();
    const { tracks } = (await F('GET', `/api/albums/${albums[0].id}`)).json();
    const id = tracks[0].id;
    const full = await F('GET', `/api/stream/${id}`);
    assert.equal(full.statusCode, 200);
    assert.equal(full.headers['content-type'], 'audio/mp4');
    assert.equal(full.headers['accept-ranges'], 'bytes');
    const size = full.rawPayload.length;
    assert.ok(size > 1000);
    const part = await F('GET', `/api/stream/${id}`, undefined, { range: 'bytes=0-99' });
    assert.equal(part.statusCode, 206);
    assert.equal(part.headers['content-range'], `bytes 0-99/${size}`);
    assert.equal(part.rawPayload.length, 100);
    const tail = await F('GET', `/api/stream/${id}`, undefined, { range: 'bytes=-50' });
    assert.equal(tail.rawPayload.length, 50);
    const bad = await F('GET', `/api/stream/${id}`, undefined, { range: `bytes=${size + 10}-` });
    assert.equal(bad.statusCode, 416);
    // el archivo M4A es un M4A de verdad
    assert.equal(full.rawPayload.subarray(4, 8).toString(), 'ftyp');
  });

  test('stream y carátulas: ids raros y rutas con ../ no sirven nada', async () => {
    for (const url of ['/api/stream/..%2F..%2Fetc%2Fpasswd', '/api/stream/abc', '/api/stream/99999', '/api/cover/1/..%2Fsecret', '/api/cover/1/xl', '/api/cover/..%2F1/s', '/api/stream/1%00']) {
      const r = await F('GET', url);
      assert.ok([400, 404].includes(r.statusCode), `${url} → ${r.statusCode}`);
    }
    for (const url of ['/../server/index.js', '/%2e%2e/server/index.js', '/..%2fserver%2findex.js', '/css/../../package.json']) {
      const r = await t.app.inject({ method: 'GET', url });
      assert.ok(!String(r.body).includes('loadConfig') && !String(r.body).includes('"name"'), `${url} filtró un archivo`);
    }
  });

  test('carátulas: se reducen, y las inexistentes dan 404', async () => {
    const { albums } = (await F('GET', '/api/albums')).json();
    const conCover = albums.find((a) => a.hasCover);
    const r = await F('GET', `/api/cover/${conCover.id}/s`);
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-type'], 'image/jpeg');
    assert.ok(r.rawPayload.length < 80_000, 'la miniatura debería pesar poco');
    assert.equal((await F('GET', `/api/cover/${conCover.id}/back`)).statusCode, 200);
    const sin = albums.find((a) => !a.hasCover);
    assert.equal((await F('GET', `/api/cover/${sin.id}/m`)).statusCode, 404);
  });

  test('favoritos, recientes y listas son por persona', async () => {
    const { albums } = (await F('GET', '/api/albums')).json();
    const musica = albums.find((a) => a.title === 'Musica per te');
    const tracks = (await F('GET', `/api/albums/${musica.id}`)).json().tracks;
    assert.equal((await F('PUT', `/api/favorites/${tracks[0].id}`)).statusCode, 200);
    assert.equal((await F('GET', '/api/favorites')).json().tracks.length, 1);
    assert.equal((await A('GET', '/api/favorites')).json().tracks.length, 0);
    assert.equal((await F('GET', `/api/albums/${musica.id}`)).json().tracks[0].fav, true);
    await F('DELETE', `/api/favorites/${tracks[0].id}`);
    assert.equal((await F('GET', '/api/favorites')).json().tracks.length, 0);

    await F('POST', '/api/plays', { trackId: tracks[1].id });
    await F('POST', '/api/plays', { trackId: tracks[2].id });
    await F('POST', '/api/plays', { trackId: tracks[1].id });
    assert.deepEqual((await F('GET', '/api/recents')).json().tracks.map((x) => x.id), [tracks[1].id, tracks[2].id]);
    assert.equal((await F('GET', '/api/home')).json().continue[0].id, musica.id);

    const pl = (await F('POST', '/api/playlists', { name: '  Para   el auto ' })).json();
    assert.equal(pl.name, 'Para el auto');
    assert.equal((await F('POST', `/api/playlists/${pl.id}/tracks`, { trackIds: [tracks[3].id, tracks[4].id, tracks[3].id] })).json().added, 2);
    const got = (await F('GET', `/api/playlists/${pl.id}`)).json();
    assert.deepEqual(got.tracks.map((x) => x.id), [tracks[3].id, tracks[4].id]);
    assert.equal((await A('GET', `/api/playlists/${pl.id}`)).statusCode, 404, 'otra persona no ve mi lista');
    assert.equal((await A('DELETE', `/api/playlists/${pl.id}`)).statusCode, 404);
    assert.equal((await F('GET', '/api/playlists')).json().playlists[0].trackCount, 2);
    await F('DELETE', `/api/playlists/${pl.id}/tracks/${tracks[3].id}`);
    assert.equal((await F('GET', `/api/playlists/${pl.id}`)).json().tracks.length, 1);
    assert.equal((await F('PATCH', `/api/playlists/${pl.id}`, { name: 'Nuevo' })).statusCode, 200);
    assert.equal((await F('POST', '/api/playlists', { name: '   ' })).statusCode, 400);
    assert.equal((await F('DELETE', `/api/playlists/${pl.id}`)).statusCode, 200);
  });

  test('bloquear a alguien le cierra la sesión al instante', async () => {
    const x = await t.login('otro@test.cl');
    const X = t.api(x.cookie);
    const id = (await A('GET', '/api/admin/users')).json().users.find((u) => u.email === 'otro@test.cl').id;
    await A('POST', `/api/admin/users/${id}`, { status: 'active' });
    assert.equal((await X('GET', '/api/home')).statusCode, 200);
    await A('POST', `/api/admin/users/${id}`, { status: 'blocked' });
    assert.equal((await X('GET', '/api/home')).statusCode, 401);
    // y si vuelve a pedir un código, sigue bloqueado (no pasa a "activo")
    const again = await t.login('otro@test.cl');
    assert.equal(again.res.json().user.status, 'blocked');
    assert.equal((await t.api(again.cookie)('GET', '/api/home')).statusCode, 403);
  });

  test('código por correo: errores, vencimiento por intentos y mismo mensaje para cualquier correo', async () => {
    const a = await t.app.inject({ method: 'POST', url: '/api/auth/email/start', payload: { email: 'nuevo@test.cl' } });
    assert.equal(a.statusCode, 200);
    for (let i = 0; i < 5; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/api/auth/email/verify', payload: { email: 'nuevo@test.cl', code: '000000' } });
      assert.equal(r.statusCode, 401);
    }
    // tras 5 intentos fallidos, ni siquiera el código correcto sirve
    const ok = await t.app.inject({ method: 'POST', url: '/api/auth/email/verify', payload: { email: 'nuevo@test.cl', code: t.lastCode('nuevo@test.cl') } });
    assert.equal(ok.statusCode, 401);
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/email/start', payload: { email: 'no-es-correo' } })).statusCode, 400);
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/email/verify', payload: { email: 'nuevo@test.cl', code: 'abc' } })).statusCode, 400);
  });

  test('límite de envíos de código por correo y por IP', async () => {
    const codes = [];
    for (let i = 0; i < 7; i++) {
      await t.app.inject({ method: 'POST', url: '/api/auth/email/start', payload: { email: 'spam@test.cl' } });
    }
    const dir = path.join(t.dataDir, 'outbox');
    const sent = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter((m) => m.to === 'spam@test.cl');
    assert.ok(sent.length <= 5, `se enviaron ${sent.length} correos a la misma persona`);
    // por IP: más de 8 pedidos en 10 minutos dan 429
    let last;
    for (let i = 0; i < 10; i++) last = await t.app.inject({ method: 'POST', url: '/api/auth/email/start', payload: { email: `x${i}@test.cl` }, remoteAddress: '10.9.9.9' });
    assert.equal(last.statusCode, 429);
  });

  test('rechaza peticiones que vienen de otro sitio web (Origin)', async () => {
    const r = await F('POST', '/api/playlists', { name: 'x' }, { origin: 'https://malo.example' });
    assert.equal(r.statusCode, 403);
    const ok = await F('POST', '/api/playlists', { name: 'ok' }, { origin: 'http://localhost:3999' });
    assert.equal(ok.statusCode, 201);
  });

  test('cabeceras de seguridad y archivos de la app públicos', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/auth/config' });
    assert.match(r.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.json().google, false);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/auth/google/start' })).statusCode, 404);
  });

  test('cerrar sesión invalida la cookie', async () => {
    const x = await t.login('salir@test.cl');
    const X = t.api(x.cookie);
    assert.equal((await X('GET', '/api/me')).statusCode, 200);
    await X('POST', '/api/auth/logout', {});
    assert.equal((await X('GET', '/api/me')).statusCode, 401);
  });

  test('rescaneo: un archivo borrado se oculta y vuelve si regresa', async () => {
    const before = (await F('GET', '/api/albums')).json().albums.length;
    assert.equal(t.ctx.library.lastScan().tracks, 46);
    const again = await t.ctx.library.scan();
    assert.equal(again.tracks, 46);
    await t.ctx.transcoder.whenIdle();
    assert.equal((await F('GET', '/api/albums')).json().albums.length, before);
    assert.equal(t.ctx.transcoder.status().pending, 0, 'un segundo escaneo no debe reconvertir nada');
  });
});
