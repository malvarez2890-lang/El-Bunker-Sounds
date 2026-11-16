import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

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
