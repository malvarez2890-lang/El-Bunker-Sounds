import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

describe('entrar en otro aparato con un código del celular', () => {
  let t, A;
  before(async () => { t = await makeApp(); A = t.api((await t.login('admin@test.cl')).cookie); });
  after(() => t.close());
  const ip = (n) => ({ remoteAddress: `10.7.0.${n}` });

  test('el código se crea desde una sesión activa y entra a la MISMA cuenta, una sola vez', async () => {
    const r = await A('POST', '/api/auth/link/create');
    assert.equal(r.statusCode, 200);
    const { code, expiresIn } = r.json();
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(expiresIn, 300);
    const pc = await t.app.inject({ method: 'POST', url: '/api/auth/link/redeem', payload: { code: code.toLowerCase().replace('-', ' ') }, ...ip(1) }); // tolerante con minúsculas y espacios
    assert.equal(pc.statusCode, 200);
    assert.equal(pc.json().user.email, 'admin@test.cl');
    const sid = pc.cookies.find((c) => c.name === 'ebs_sid')?.value;
    assert.ok(sid);
    const me = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `ebs_sid=${sid}` } });
    assert.equal(me.json().user.email, 'admin@test.cl', 'sin crear otra cuenta');
    const again = await t.app.inject({ method: 'POST', url: '/api/auth/link/redeem', payload: { code }, ...ip(2) });
    assert.equal(again.statusCode, 401, 'ya se usó');
  });

  test('vencido, falso, o de alguien sin acceso: no entra', async () => {
    const { code } = (await A('POST', '/api/auth/link/create')).json();
    t.ctx.db.prepare('UPDATE link_codes SET expires_at = 1').run();
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/link/redeem', payload: { code }, ...ip(3) })).statusCode, 401, 'vencido');
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/link/redeem', payload: { code: 'AAAA-AAAA' }, ...ip(4) })).statusCode, 401);
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/link/redeem', payload: {}, ...ip(5) })).statusCode, 401);
    // un pendiente no puede crear códigos
    const P = t.api((await t.login('nuevo@test.cl')).cookie);
    assert.equal((await P('POST', '/api/auth/link/create')).statusCode, 403);
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/link/create' })).statusCode, 401, 'sin sesión tampoco');
    // si bloquean al dueño del código, deja de servir
    const { code: c2 } = (await A('POST', '/api/auth/link/create')).json();
    t.ctx.db.prepare("UPDATE users SET status = 'blocked' WHERE email = 'admin@test.cl'").run();
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/link/redeem', payload: { code: c2 }, ...ip(6) })).statusCode, 401);
    t.ctx.db.prepare("UPDATE users SET status = 'active' WHERE email = 'admin@test.cl'").run();
  });
});
