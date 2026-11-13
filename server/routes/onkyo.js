// Control del Onkyo desde la app. Solo administradores.
export default async function onkyoRoutes(app, { auth, onkyo }) {
  const guard = { preHandler: (req, reply, done) => (auth.needAdmin(req, reply) ? done() : undefined) };
  const lim = (max) => ({ ...guard, config: { rateLimit: { max, timeWindow: '1 minute' } } });
  const need = (reply) => { if (!onkyo.enabled) { reply.code(404).send({ error: 'onkyo_no_configurado' }); return false; } return true; };
  const fail = (reply, err) => {
    const code = String(err?.message || 'error');
    const map = { onkyo_sin_conexion: 502, onkyo_no_enciende: 504, sin_canciones: 400, accion_invalida: 400, nada_que_controlar: 409 };
    return reply.code(map[code] || 502).send({ error: /^[a-z_0-9]+$/i.test(code) ? code : 'onkyo_error' });
  };

  app.get('/api/onkyo', lim(120), async (req, reply) => (need(reply) ? onkyo.status() : undefined));

  app.post('/api/onkyo/play', lim(30), async (req, reply) => {
    if (!need(reply)) return;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((n) => Number.isInteger(n) && n > 0).slice(0, 300) : [];
    if (!ids.length) return reply.code(400).send({ error: 'datos_invalidos' });
    const index = Number.isInteger(req.body?.index) ? req.body.index : 0;
    try { await onkyo.play(req.user.id, ids, index); } catch (e) { req.log.warn({ err: e.message }, 'Onkyo: no pude reproducir'); return fail(reply, e); }
    return onkyo.status();
  });

  app.post('/api/onkyo/control', lim(60), async (req, reply) => {
    if (!need(reply)) return;
    const { action, index } = req.body || {};
    try {
      if (action === 'jump') await onkyo.jump(index);
      else await onkyo.control(String(action));
    } catch (e) { req.log.warn({ err: e.message }, 'Onkyo: control falló'); return fail(reply, e); }
    return onkyo.status();
  });

  app.post('/api/onkyo/volume', lim(120), async (req, reply) => {
    if (!need(reply)) return;
    const level = req.body?.level;
    if (!Number.isFinite(level)) return reply.code(400).send({ error: 'datos_invalidos' });
    try { await onkyo.setVolume(level); } catch (e) { return fail(reply, e); }
    return onkyo.status();
  });

  app.post('/api/onkyo/power', lim(20), async (req, reply) => {
    if (!need(reply)) return;
    try { await onkyo.power(!!req.body?.on); } catch (e) { return fail(reply, e); }
    return onkyo.status();
  });
}
