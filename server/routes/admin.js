export default async function adminRoutes(app, { auth, db, library, transcoder, config }) {
  const guard = { preHandler: (req, reply, done) => (auth.needAdmin(req, reply) ? done() : undefined) };
  const userRow = (u) => ({
    id: u.id, email: u.email, name: u.name, status: u.status, isAdmin: !!u.is_admin,
    createdAt: u.created_at, lastSeen: u.last_seen,
  });

  app.get('/api/admin/users', guard, async () => ({
    users: db.prepare("SELECT * FROM users ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, created_at DESC").all().map(userRow),
  }));

  app.post('/api/admin/users/:id', guard, async (req, reply) => {
    const id = Number(req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!user) return reply.code(404).send({ error: 'no_encontrado' });
    if (id === req.user.id) return reply.code(400).send({ error: 'no_puedes_cambiarte_a_ti' });
    const { status, isAdmin } = req.body || {};
    if (status !== undefined) {
      if (!['active', 'blocked', 'pending'].includes(status)) return reply.code(400).send({ error: 'datos_invalidos' });
      db.prepare('UPDATE users SET status=? WHERE id=?').run(status, id);
      if (status !== 'active') db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); // le cierra la sesión
    }
    if (isAdmin !== undefined) db.prepare('UPDATE users SET is_admin=? WHERE id=?').run(isAdmin ? 1 : 0, id);
    return { user: userRow(db.prepare('SELECT * FROM users WHERE id=?').get(id)) };
  });

  app.delete('/api/admin/users/:id', guard, async (req, reply) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return reply.code(400).send({ error: 'no_puedes_cambiarte_a_ti' });
    db.prepare('DELETE FROM users WHERE id=?').run(id);
    return { ok: true };
  });

  app.get('/api/admin/library', guard, async () => ({
    ...transcoder.status(), scanning: library.scanning(), lastScan: library.lastScan(),
    errors: db.prepare("SELECT id, title, audio_error AS error FROM tracks WHERE audio_status='error' AND missing=0 LIMIT 20").all(),
  }));

  app.post('/api/admin/scan', { ...guard, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async () => {
    library.scan().catch((e) => app.log.error(e));
    return { ok: true };
  });

  app.post('/api/admin/retry', guard, async () => {
    const n = transcoder.retryErrors();
    transcoder.kick();
    return { ok: true, retried: n };
  });
}
