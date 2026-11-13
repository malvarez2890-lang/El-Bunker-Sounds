import { isEmail } from '../util.js';

export default async function authRoutes(app, { auth, config }) {
  const strict = (max, win = '10 minutes') => ({ config: { rateLimit: { max, timeWindow: win } } });

  app.get('/api/auth/config', async () => ({ google: auth.googleEnabled(), email: true }));

  // Siempre responde igual, exista o no el correo, para no revelar quién tiene cuenta.
  app.post('/api/auth/email/start', strict(8), async (req, reply) => {
    const email = req.body?.email;
    if (!isEmail(email)) return reply.code(400).send({ error: 'correo_invalido' });
    try {
      await auth.startEmailLogin(email);
    } catch (err) {
      req.log.error({ err: err.message }, 'no se pudo enviar el código');
      return reply.code(503).send({ error: 'no_se_pudo_enviar' });
    }
    return { ok: true };
  });

  app.post('/api/auth/email/verify', strict(12), async (req, reply) => {
    const { email, code } = req.body || {};
    if (!isEmail(email) || typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return reply.code(400).send({ error: 'datos_invalidos' });
    const user = await auth.verifyEmailLogin(email, code);
    if (!user) return reply.code(401).send({ error: 'codigo_incorrecto' });
    auth.issueSession(reply, user.id);
    return { user: auth.publicUser(user) };
  });

  app.get('/api/auth/google/start', strict(20), async (req, reply) => {
    if (!auth.googleEnabled()) return reply.code(404).send({ error: 'google_no_configurado' });
    return reply.redirect(auth.googleStart(reply));
  });

  app.get('/api/auth/google/callback', strict(20), async (req, reply) => {
    if (!auth.googleEnabled()) return reply.code(404).send({ error: 'google_no_configurado' });
    try {
      const user = await auth.googleCallback(req, reply);
      auth.issueSession(reply, user.id);
      return reply.redirect('/');
    } catch (err) {
      req.log.warn({ err: err.message }, 'falló el inicio con Google');
      return reply.redirect('/#/entrar?error=google');
    }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    auth.destroySession(req, reply);
    return { ok: true };
  });

  // Sin sesión responde user:null (200) para que el navegador no muestre errores rojos en la consola.
  app.get('/api/me', async (req) => ({ user: req.user ? auth.publicUser(req.user) : null }));

  app.patch('/api/me', async (req, reply) => {
    if (!auth.needUser(req, reply)) return;
    const name = String(req.body?.name ?? '').trim().slice(0, 40);
    if (!name) return reply.code(400).send({ error: 'nombre_vacio' });
    app.db.prepare('UPDATE users SET name=? WHERE id=?').run(name, req.user.id);
    return { user: auth.publicUser({ ...req.user, name }) };
  });
}
