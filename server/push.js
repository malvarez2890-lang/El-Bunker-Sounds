// Avisos al celular (Web Push): cada amigo activa los avisos una vez; el servidor manda notificaciones sin apps externas.
import fs from 'node:fs';
import path from 'node:path';
import { generateVAPIDKeys, sendNotification } from 'web-push';

// Solo se le habla a los servicios de notificaciones de los navegadores. Si no, un usuario podría hacer que el servidor
// llame a cualquier dirección (por ejemplo, equipos de tu red).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
export function endpointAllowed(endpoint, extraHosts = []) {
  try {
    const u = new URL(endpoint);
    if (extraHosts.includes(u.hostname)) return true;
    return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}
const b64u = (s, min, max) => typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s) && s.length >= min && s.length <= max;

export function createPush({ db, config, log, sender }) {
  const keyFile = path.join(config.dataDir, 'vapid.json');
  let keys = null;
  try { keys = JSON.parse(fs.readFileSync(keyFile, 'utf8')); } catch { /* primera vez */ }
  if (!keys?.publicKey || !keys?.privateKey) {
    keys = generateVAPIDKeys();
    try { fs.writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 }); } catch (e) { log?.warn?.({ err: e.message }, 'no pude guardar las claves de avisos'); }
  }
  const send = sender || ((sub, payload) => sendNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload,
    { vapidDetails: { subject: config.push.subject, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 60 * 60 * 24, timeout: 10000 }));

  const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
  const setSetting = (k, v) => db.prepare('INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

  async function deliver(rows, payload) {
    const body = JSON.stringify({ title: String(payload.title || 'El Búnker Sound').slice(0, 80), body: String(payload.body || '').slice(0, 200), url: payload.url || '/', tag: payload.tag });
    const out = { sent: 0, failed: 0, removed: 0 };
    for (let i = 0; i < rows.length; i += 5) {
      await Promise.all(rows.slice(i, i + 5).map(async (sub) => {
        try { await send(sub, body); out.sent++; } catch (err) {
          if (err?.statusCode === 404 || err?.statusCode === 410) { db.prepare('DELETE FROM push_subs WHERE id = ?').run(sub.id); out.removed++; } // el celular ya no los quiere
          else { out.failed++; log?.warn?.({ status: err?.statusCode, err: String(err?.message || err).slice(0, 120) }, 'no pude mandar un aviso'); }
        }
      }));
    }
    return out;
  }

  let announcing = false;
  return {
    publicKey: () => keys.publicKey,
    subscribe(userId, sub) {
      const ep = sub?.endpoint;
      if (typeof ep !== 'string' || ep.length > 700 || !endpointAllowed(ep, config.push.extraHosts) || !b64u(sub?.keys?.p256dh, 40, 120) || !b64u(sub?.keys?.auth, 10, 40)) return false;
      db.prepare(`INSERT INTO push_subs(user_id, endpoint, p256dh, auth, created_at) VALUES(?,?,?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`).run(userId, ep, sub.keys.p256dh, sub.keys.auth, Math.floor(Date.now() / 1000));
      return true;
    },
    unsubscribe(userId, endpoint) { return Number(db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').run(userId, String(endpoint || '')).changes); },
    countFor: (userId) => Number(db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').get(userId).n),
    stats: () => ({
      devices: Number(db.prepare("SELECT COUNT(*) AS n FROM push_subs s JOIN users u ON u.id = s.user_id WHERE u.status = 'active'").get().n),
      people: Number(db.prepare("SELECT COUNT(DISTINCT s.user_id) AS n FROM push_subs s JOIN users u ON u.id = s.user_id WHERE u.status = 'active'").get().n),
    }),
    notifyAll: (payload) => deliver(db.prepare("SELECT s.* FROM push_subs s JOIN users u ON u.id = s.user_id WHERE u.status = 'active'").all(), payload),
    notifyUser: (userId, payload) => deliver(db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(userId), payload),

    autoNewMusic: () => getSetting('auto_new_music') === '1',
    setAutoNewMusic(on) {
      setSetting('auto_new_music', on ? '1' : '0');
      // lo que ya existe no se avisa: solo lo que llegue desde ahora (y lo programado, que se avisa el día que sale)
      if (on) db.prepare('UPDATE tracks SET announced = 1 WHERE NOT (release_date IS NOT NULL AND release_date > ebs_today())').run();
    },
    /** Si está activado, avisa (una sola vez) de las canciones nuevas que ya están listas para escuchar. */
    async announceNewMusic() {
      if (announcing || !this.autoNewMusic()) return null;
      announcing = true;
      try {
        const rows = db.prepare(`SELECT t.id, al.id AS albumId, al.title AS album, ar.name AS artist FROM tracks t
          JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = t.artist_id
          WHERE t.announced = 0 AND t.audio_status = 'ok' AND t.missing = 0 AND al.launched = 1
          AND NOT (t.release_date IS NOT NULL AND t.release_date > ebs_today())`).all(); // lo programado se avisa el día que sale
        if (!rows.length) return null;
        db.prepare(`UPDATE tracks SET announced = 1 WHERE id IN (${rows.map(() => '?').join(',')})`).run(...rows.map((r) => r.id));
        const albums = [...new Set(rows.map((r) => r.albumId))];
        const payload = albums.length === 1
          ? { title: 'Música nueva', body: `${rows[0].artist} · ${rows[0].album} (${rows.length === 1 ? '1 canción nueva' : `${rows.length} canciones nuevas`})`, url: `/#/album/${albums[0]}`, tag: `music-${albums[0]}` }
          : { title: 'Música nueva', body: `${rows.length} canciones nuevas en El Búnker Sound`, url: '/', tag: 'music-new' };
        return await this.notifyAll(payload);
      } finally { announcing = false; }
    },
  };
}
