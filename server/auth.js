// Sesiones, código por correo e inicio con Google. Los usuarios nuevos quedan "pendientes" hasta que un admin los apruebe.
import crypto from 'node:crypto';
import { sha256, randomToken, now, isEmail, safeEqual } from './util.js';
import { loginCodeMail, accessRequestMail } from './mail.js';

const COOKIE = 'ebs_sid';
const CODE_TTL = 10 * 60;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_HOUR = 5;

export function createAuth({ db, config, mailer, log }) {
  const isAdminEmail = (email) => config.adminEmails.includes(email);

  function cookieOpts(maxAgeSec) {
    return { path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: maxAgeSec };
  }

  function issueSession(reply, userId) {
    const token = randomToken(32);
    const ts = now();
    const ttl = config.sessionDays * 86400;
    db.prepare('INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(sha256(token), userId, ts, ts + ttl);
    reply.setCookie(COOKIE, token, cookieOpts(ttl));
  }

  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, status: u.status, isAdmin: !!u.is_admin });

  /** Busca la sesión de la cookie. Devuelve el usuario o null. */
  function userFromRequest(req, reply) {
    const token = req.cookies?.[COOKIE];
    if (!token) return null;
    const row = db.prepare(`SELECT s.id AS sid, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(sha256(token));
    if (!row) return null;
    const ts = now();
    if (row.expires_at <= ts) {
      db.prepare('DELETE FROM sessions WHERE id=?').run(row.sid);
      return null;
    }
    // Renueva la sesión si lleva más de un día sin renovarse.
    const ttl = config.sessionDays * 86400;
    if (row.expires_at - ts < ttl - 86400) {
      db.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(ts + ttl, row.sid);
      reply.setCookie(COOKIE, token, cookieOpts(ttl));
    }
    if (!row.last_seen || ts - row.last_seen > 300) db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(ts, row.id);
    return row;
  }

  function destroySession(req, reply) {
    const token = req.cookies?.[COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE id=?').run(sha256(token));
    reply.clearCookie(COOKIE, { path: '/' });
  }

  /** Crea o actualiza al usuario. Los nuevos quedan pendientes salvo los correos de ADMIN_EMAILS. */
  async function findOrCreateUser({ email, name, googleSub }) {
    email = email.trim().toLowerCase();
    let user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    const admin = isAdminEmail(email);
    if (!user) {
      const display = (name || email.split('@')[0]).trim().slice(0, 60) || 'Amigo';
      const info = db.prepare('INSERT INTO users(email,name,google_sub,status,is_admin,created_at) VALUES(?,?,?,?,?,?)')
        .run(email, display, googleSub || null, admin ? 'active' : 'pending', admin ? 1 : 0, now());
      user = db.prepare('SELECT * FROM users WHERE id=?').get(Number(info.lastInsertRowid));
      if (!admin) notifyAdmins(user).catch((e) => log?.warn?.({ err: e.message }, 'no se pudo avisar a los admins'));
    } else {
      if (admin && (!user.is_admin || user.status !== 'active')) {
        db.prepare("UPDATE users SET is_admin=1, status='active' WHERE id=?").run(user.id);
      }
      if (googleSub && !user.google_sub) db.prepare('UPDATE users SET google_sub=? WHERE id=?').run(googleSub, user.id);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    }
    return user;
  }

  async function notifyAdmins(user) {
    const admins = db.prepare("SELECT email FROM users WHERE is_admin=1 AND status='active'").all().map((r) => r.email);
    const to = [...new Set([...admins, ...config.adminEmails])];
    if (!to.length) return;
    const m = accessRequestMail(user, config.baseUrl);
    await mailer.send({ to: to.join(','), ...m });
  }

  // ---- código por correo ----
  async function startEmailLogin(email) {
    email = email.trim().toLowerCase();
    const ts = now();
    const row = db.prepare('SELECT * FROM login_codes WHERE email=?').get(email);
    let sent = 0, windowStart = ts;
    if (row && ts - row.window_start < 3600) { sent = row.sent_count; windowStart = row.window_start; }
    if (sent >= MAX_SENDS_PER_HOUR) return { throttled: true };
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.prepare(`INSERT INTO login_codes(email,code_hash,expires_at,attempts,sent_count,window_start) VALUES(?,?,?,0,?,?)
      ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, sent_count=excluded.sent_count, window_start=excluded.window_start`)
      .run(email, sha256(`${email}:${code}`), ts + CODE_TTL, sent + 1, windowStart);
    await mailer.send({ to: email, ...loginCodeMail(code) });
    return { ok: true };
  }

  async function verifyEmailLogin(email, code) {
    email = email.trim().toLowerCase();
    const row = db.prepare('SELECT * FROM login_codes WHERE email=?').get(email);
    if (!row || row.expires_at <= now() || row.attempts >= MAX_ATTEMPTS) return null;
    db.prepare('UPDATE login_codes SET attempts=attempts+1 WHERE email=?').run(email);
    if (!safeEqual(row.code_hash, sha256(`${email}:${String(code).trim()}`))) return null;
    db.prepare('DELETE FROM login_codes WHERE email=?').run(email);
    return findOrCreateUser({ email });
  }

  // ---- Google (OpenID Connect con PKCE) ----
  const googleEnabled = () => !!(config.google.clientId && config.google.clientSecret);
  const redirectUri = () => `${config.baseUrl}/api/auth/google/callback`;
  const b64url = (buf) => Buffer.from(buf).toString('base64url');

  function googleStart(reply) {
    const state = randomToken(16);
    const verifier = randomToken(32);
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    reply.setCookie('ebs_oauth', `${state}.${verifier}`, { ...cookieOpts(600) });
    const url = new URL(config.google.authUrl);
    url.search = new URLSearchParams({
      client_id: config.google.clientId, redirect_uri: redirectUri(), response_type: 'code',
      scope: 'openid email profile', state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
    }).toString();
    return url.toString();
  }

  async function googleCallback(req, reply) {
    const [state, verifier] = String(req.cookies?.ebs_oauth || '').split('.');
    reply.clearCookie('ebs_oauth', { path: '/' });
    if (!state || !verifier || !safeEqual(state, String(req.query.state || '')) || !req.query.code) throw new Error('estado inválido');
    const res = await fetch(config.google.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(req.query.code), client_id: config.google.clientId, client_secret: config.google.clientSecret,
        redirect_uri: redirectUri(), grant_type: 'authorization_code', code_verifier: verifier,
      }),
    });
    if (!res.ok) throw new Error(`Google respondió ${res.status}`);
    const { id_token: idToken } = await res.json();
    // El token llega directo desde Google por HTTPS, así que basta con validar su contenido.
    const claims = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString());
    const okIss = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
    if (!okIss || claims.aud !== config.google.clientId || claims.exp * 1000 < Date.now() || !claims.email || claims.email_verified !== true) {
      throw new Error('token de Google no válido');
    }
    return findOrCreateUser({ email: claims.email, name: claims.name, googleSub: claims.sub });
  }

  // ---- ganchos de Fastify ----
  const needUser = (req, reply) => {
    const u = req.user;
    if (!u) { reply.code(401).send({ error: 'no_session' }); return false; }
    return true;
  };
  const needActive = (req, reply) => {
    if (!needUser(req, reply)) return false;
    if (req.user.status !== 'active') { reply.code(403).send({ error: req.user.status }); return false; }
    return true;
  };
  const needAdmin = (req, reply) => {
    if (!needActive(req, reply)) return false;
    if (!req.user.is_admin) { reply.code(403).send({ error: 'forbidden' }); return false; }
    return true;
  };

  return {
    COOKIE, issueSession, userFromRequest, destroySession, publicUser, findOrCreateUser,
    startEmailLogin, verifyEmailLogin, googleEnabled, googleStart, googleCallback, needUser, needActive, needAdmin,
  };
}
