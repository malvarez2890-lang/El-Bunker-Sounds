// Avisos al celular: activar/desactivar (cada persona) y enviar/probar (administrador).
export default async function pushRoutes(app, { auth, push }) {
  const user = { preHandler: (req, reply, done) => (auth.needActive(req, reply) ? done() : undefined) };
  const admin = (max = 10) => ({ preHandler: (req, reply, done) => (auth.needAdmin(req, reply) ? done() : undefined), config: { rateLimit: { max, timeWindow: '1 minute' } } });

  app.get('/api/push/config', user, async (req) => ({ publicKey: push.publicKey(), subscribed: push.countFor(req.user.id) > 0 }));

  app.post('/api/push/subscribe', { ...user, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!push.subscribe(req.user.id, req.body)) return reply.code(400).send({ error: 'datos_invalidos' });
    return { ok: true };
  });
  app.post('/api/push/unsubscribe', user, async (req) => { push.unsubscribe(req.user.id, req.body?.endpoint); return { ok: true }; });

  app.get('/api/admin/push', admin(60), async () => ({ ...push.stats(), autoNewMusic: push.autoNewMusic() }));
  app.post('/api/admin/push/settings', admin(), async (req, reply) => {
    if (typeof req.body?.autoNewMusic !== 'boolean') return reply.code(400).send({ error: 'datos_invalidos' });
    push.setAutoNewMusic(req.body.autoNewMusic);
    return { ...push.stats(), autoNewMusic: push.autoNewMusic() };
  });
  app.post('/api/admin/push/test', admin(), async (req) => ({
    result: await push.notifyUser(req.user.id, { title: 'Prueba de aviso', body: 'Si ves esto, los avisos funcionan en tu celular.', url: '/', tag: 'test' }),
  }));
}
