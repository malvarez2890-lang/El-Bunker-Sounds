import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createMailer } from './mail.js';
import { createAuth } from './auth.js';
import { createLibraryQueries } from './library.js';
import { createTranscoder, createCovers } from './media.js';
import { scanLibrary } from './scanner.js';
import authRoutes from './routes/auth.js';
import apiRoutes from './routes/api.js';
import adminRoutes from './routes/admin.js';

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

export async function buildApp(config, { logger = true } = {}) {
  const app = Fastify({
    logger: logger ? { level: config.logLevel } : false,
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
  });
  const log = app.log;
  const db = openDb(config.dataDir);
  const mailer = createMailer({ config, log });
  const auth = createAuth({ db, config, mailer, log });
  const lib = createLibraryQueries(db);
  const transcoder = createTranscoder({ db, config, log });
  const covers = createCovers({ config });

  // Escaneo de la biblioteca (uno a la vez), luego convierte lo nuevo.
  let scanning = null;
  let lastScan = null;
  const library = {
    scanning: () => !!scanning,
    lastScan: () => lastScan,
    async scan() {
      if (scanning) return scanning;
      scanning = (async () => {
        try {
          lastScan = { at: Date.now(), ...(await scanLibrary({ db, config, log })) };
          transcoder.kick();
          transcoder.cleanup().catch(() => {});
        } catch (err) {
          lastScan = { at: Date.now(), error: err.message };
          log.error({ err: err.message }, 'falló el escaneo');
        } finally {
          scanning = null;
        }
        return lastScan;
      })();
      return scanning;
    },
  };

  app.decorate('db', db);
  app.decorate('ctx', { config, db, auth, lib, library, transcoder, covers, mailer });

  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 1200, timeWindow: '1 minute' });

  // Cabeceras de seguridad.
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (config.secureCookies) reply.header('Strict-Transport-Security', 'max-age=15552000');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', reply.getHeader('Cache-Control') || 'no-store');
  });

  // Protección contra peticiones desde otros sitios: solo se acepta el origen propio.
  const ownHost = new URL(config.baseUrl).host;
  app.addHook('onRequest', async (req, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* origen inválido */ }
      if (host !== ownHost) return reply.code(403).send({ error: 'origen_no_permitido' });
    }
  });

  // Identifica al usuario (si hay sesión) en cada petición.
  app.addHook('onRequest', async (req, reply) => {
    req.user = req.url.startsWith('/api/') ? auth.userFromRequest(req, reply) : null;
  });

  await app.register(authRoutes, { auth, config });
  await app.register(apiRoutes, { auth, config, lib, db, covers });
  await app.register(adminRoutes, { auth, db, library, transcoder, config });

  // Archivos de la app (HTML, JS, CSS, fuentes e iconos): son públicos; la música no.
  await app.register(fastifyStatic, {
    root: webDir,
    setHeaders(res, file) {
      res.setHeader('Cache-Control', /[\\/](fonts|icons)[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  app.setNotFoundHandler(async (req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && !path.extname(req.url.split('?')[0])) {
      return reply.type('text/html').header('Cache-Control', 'no-cache').send(fs.createReadStream(path.join(webDir, 'index.html')));
    }
    return reply.code(404).send({ error: 'no_encontrado' });
  });

  return { app, ctx: app.ctx };
}
