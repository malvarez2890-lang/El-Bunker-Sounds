import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeApp } from './helpers.js';
import { crearNovedad, PRESETS } from '../server/cli/crear-novedad.js';

describe('novedades (tarjetas del administrador)', () => {
  let t, A, F;
  before(async () => {
    t = await makeApp();
    A = t.api((await t.login('admin@test.cl')).cookie);
    const friend = await t.login('amigo@test.cl');
    await A('POST', `/api/admin/users/${friend.res.json().user.id}`, { status: 'active' });
    F = t.api(friend.cookie);
  });
  after(() => t.close());

  test('solo el administrador crea, edita y borra', async () => {
    for (const [m, u, b] of [['GET', '/api/admin/news'], ['POST', '/api/admin/news', { title: 'x' }], ['POST', '/api/admin/news/1', { title: 'x' }], ['DELETE', '/api/admin/news/1']]) {
      assert.equal((await F(m, u, b)).statusCode, 403, u);
      assert.equal((await t.app.inject({ method: m, url: u, payload: b })).statusCode, 401, u);
    }
  });

  test('crear: título obligatorio, textos recortados y álbum inexistente ignorado', async () => {
    assert.equal((await A('POST', '/api/admin/news', { title: '   ' })).statusCode, 400);
    const albumId = (await A('GET', '/api/albums')).json().albums[0].id;
    const r = await A('POST', '/api/admin/news', { title: 'Próximo lanzamiento', body: 'x'.repeat(900), albumId });
    assert.equal(r.statusCode, 200, r.body);
    const item = r.json().item;
    assert.equal(item.body.length, 500);
    assert.equal(item.album.id, albumId);
    assert.equal(item.active, true);
    const sin = (await A('POST', '/api/admin/news', { title: 'Sin álbum', albumId: 99999 })).json().item;
    assert.equal(sin.album, null);
  });

  test('Inicio muestra solo las visibles, la más nueva primero; ocultar y borrar las quita', async () => {
    const all = (await A('GET', '/api/admin/news')).json().news;
    assert.equal(all.length, 2);
    let home = (await F('GET', '/api/home')).json();
    assert.deepEqual(home.news.map((n) => n.title), ['Sin álbum', 'Próximo lanzamiento']);
    const first = home.news[0];
    const up = await A('POST', `/api/admin/news/${first.id}`, { active: false });
    assert.equal(up.json().item.active, false);
    home = (await F('GET', '/api/home')).json();
    assert.deepEqual(home.news.map((n) => n.title), ['Próximo lanzamiento']);
    assert.equal((await A('POST', `/api/admin/news/${first.id}`, { title: '' })).statusCode, 400);
    assert.equal((await A('POST', '/api/admin/news/99999', { title: 'x' })).statusCode, 404);
    assert.equal((await A('DELETE', `/api/admin/news/${first.id}`)).statusCode, 200);
    assert.equal((await A('DELETE', `/api/admin/news/${first.id}`)).statusCode, 404);
    assert.equal((await A('GET', '/api/admin/news')).json().news.length, 1);
  });

  test('el texto no se interpreta como código (se guarda tal cual)', async () => {
    const r = await A('POST', '/api/admin/news', { title: '<img src=x onerror=alert(1)>', body: '<b>hola</b>' });
    assert.equal(r.json().item.title, '<img src=x onerror=alert(1)>');
  });
});

describe('crear una novedad desde la terminal del servidor', () => {
  let t;
  before(async () => { t = await makeApp(); });
  after(() => t.close());

  test('la plantilla de La Vita È Un Gioco existe y cabe en los límites de la tarjeta', () => {
    const p = PRESETS['la-vita-singles'];
    assert.ok(p.titulo.length <= 80 && p.texto.length <= 500);
    assert.match(p.texto, /21 de noviembre/);
  });
  test('sin el álbum en la biblioteca, avisa y no crea nada', () => {
    const r = crearNovedad({ db: t.ctx.db, argv: ['la-vita-singles'] });
    assert.equal(r.ok, false);
    assert.match(r.msg, /Buscar música nueva/);
    assert.equal(t.ctx.news.list({ all: true }).length, 0);
  });
  test('con el álbum: crea la novedad enlazada, y repetir el comando no la duplica', () => {
    const argv = ['--titulo', 'Prueba', '--texto', 'Hola', '--album', 'musica per te'];
    const r = crearNovedad({ db: t.ctx.db, argv });
    assert.equal(r.ok, true, r.msg);
    assert.ok(r.item.album, 'enlazada al álbum');
    assert.equal(r.item.active, true);
    assert.match(crearNovedad({ db: t.ctx.db, argv }).msg, /Ya existía/);
    assert.equal(t.ctx.news.list({ all: true }).length, 1);
  });
  test('la plantilla "ya salió" esconde la noticia anterior de los singles', () => {
    assert.ok(PRESETS['la-vita-lanzado'].titulo.length <= 80 && PRESETS['la-vita-lanzado'].texto.length <= 500);
    const old = t.ctx.news.create({ title: PRESETS['la-vita-lanzado'].reemplaza[0], body: 'x' });
    // (la biblioteca de prueba no tiene La Vita: se usa otro álbum para comprobar el reemplazo)
    const r = crearNovedad({ db: t.ctx.db, argv: ['--titulo', '¡Ya salió!', '--album', 'musica per te'] });
    assert.equal(r.ok, true, r.msg);
    assert.equal(t.ctx.news.get(old.id).active, true, 'sin plantilla no se esconde nada');
    const p = PRESETS['la-vita-lanzado'];
    PRESETS.__prueba = { ...p, album: 'musica per te', titulo: 'Ya salió (prueba)' };
    const r2 = crearNovedad({ db: t.ctx.db, argv: ['__prueba'] });
    delete PRESETS.__prueba;
    assert.equal(r2.ok, true, r2.msg);
    assert.equal(t.ctx.news.get(old.id).active, false, 'la anterior queda escondida');
  });
  test('sin título ni plantilla, explica qué falta', () => {
    assert.equal(crearNovedad({ db: t.ctx.db, argv: [] }).ok, false);
  });
});

describe('aviso por correo de que salió un álbum', () => {
  test('sin --enviar no manda nada; con --enviar, solo a los activos', async () => {
    const { avisarPorCorreo, AVISOS } = await import('../server/cli/avisar-por-correo.js');
    const t = await makeApp();
    try {
      const db = t.ctx.db;
      const ts = Math.floor(Date.now() / 1000);
      for (const [email, name, status] of [['ana@test.cl', 'Ana Pérez', 'active'], ['beto@test.cl', 'Beto', 'pending'], ['caro@test.cl', 'Caro', 'blocked'], ['dani@test.cl', 'Dani <b>', 'active']]) {
        db.prepare('INSERT INTO users(email,name,status,created_at) VALUES(?,?,?,?)').run(email, name, status, ts);
      }
      AVISOS.__prueba = { album: 'musica per te', texto: 'ya salió el álbum.' };
      const outbox = () => (fs.existsSync(path.join(t.dataDir, 'outbox')) ? fs.readdirSync(path.join(t.dataDir, 'outbox')).map((f) => JSON.parse(fs.readFileSync(path.join(t.dataDir, 'outbox', f), 'utf8'))) : []);
      const antes = outbox().length;
      const seco = await avisarPorCorreo({ db, config: t.config, mailer: t.ctx.mailer, aviso: '__prueba', enviar: false });
      assert.equal(seco.ok, true); assert.equal(seco.enviado, false);
      assert.deepEqual(seco.to.filter((e) => e.endsWith('@test.cl')).sort(), ['ana@test.cl', 'dani@test.cl']);
      assert.equal(outbox().length, antes, 'no se envió nada');
      const real = await avisarPorCorreo({ db, config: t.config, mailer: t.ctx.mailer, aviso: '__prueba', enviar: true, pausaMs: 0 });
      assert.equal(real.enviado, true);
      const nuevos = outbox().slice(antes);
      assert.ok(nuevos.every((m) => !m.to.includes(',')), 'un correo por persona (nadie ve a los demás)');
      assert.ok(nuevos.some((m) => m.to === 'ana@test.cl' && /Hola Ana:/.test(m.text) && /Ya salió/.test(m.subject)));
      assert.ok(!nuevos.some((m) => ['beto@test.cl', 'caro@test.cl'].includes(m.to)), 'pendientes y bloqueados no reciben');
      delete AVISOS.__prueba;
      assert.equal((await avisarPorCorreo({ db, config: t.config, mailer: t.ctx.mailer, aviso: 'no-existe' })).ok, false);
    } finally { await t.close(); }
  });
});
