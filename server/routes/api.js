import fs from 'node:fs';
import path from 'node:path';
import { now } from '../util.js';

const intParam = (v) => (/^\d{1,12}$/.test(String(v)) ? Number(v) : NaN);

export default async function apiRoutes(app, { auth, config, lib, db, covers }) {
  const guard = { preHandler: (req, reply, done) => (auth.needActive(req, reply) ? done() : undefined) };
  const bad = (reply, msg = 'datos_invalidos') => reply.code(400).send({ error: msg });
  const notFound = (reply) => reply.code(404).send({ error: 'no_encontrado' });

  // ---------- biblioteca ----------
  app.get('/api/home', guard, async (req) => {
    const latest = lib.allAlbums().slice(0, 12);
    return {
      featured: latest[0] || null,
      latest,
      continue: lib.recentAlbums(req.user.id, 12),
      counts: db.prepare(`SELECT (SELECT COUNT(*) FROM tracks WHERE missing=0 AND audio_status='ok') AS tracks,
        (SELECT COUNT(*) FROM albums WHERE missing=0) AS albums, (SELECT COUNT(*) FROM artists WHERE missing=0) AS artists`).get(),
    };
  });

  app.get('/api/albums', guard, async (req) => {
    const kind = ['album', 'ep', 'single'].includes(req.query.kind) ? req.query.kind : null;
    return { albums: lib.allAlbums(kind) };
  });
  app.get('/api/albums/:id', guard, async (req, reply) => {
    const id = intParam(req.params.id);
    if (Number.isNaN(id)) return bad(reply);
    return lib.album(req.user.id, id) || notFound(reply);
  });
  app.get('/api/artists', guard, async () => ({ artists: lib.artists() }));
  app.get('/api/artists/:id', guard, async (req, reply) => {
    const id = intParam(req.params.id);
    if (Number.isNaN(id)) return bad(reply);
    return lib.artist(req.user.id, id) || notFound(reply);
  });
  app.get('/api/tracks', guard, async (req, reply) => {
    const ids = String(req.query.ids || '').split(',').map(intParam).filter((n) => !Number.isNaN(n)).slice(0, 300);
    return { tracks: lib.byIds(req.user.id, ids) };
  });
  app.get('/api/shuffle', guard, async (req) => ({
    tracks: lib.tracks(req.user.id, "AND t.audio_status = 'ok'", [], 'ORDER BY RANDOM() LIMIT 100'),
  }));
  app.get('/api/search', guard, async (req) => lib.search(req.user.id, String(req.query.q || '').slice(0, 80)));

  // ---------- audio y carátulas (solo con sesión) ----------
  app.get('/api/stream/:id', guard, async (req, reply) => {
    const id = intParam(req.params.id);
    if (Number.isNaN(id)) return bad(reply);
    const t = lib.trackForStream(id);
    if (!t || t.audio_status !== 'ok' || !t.audio_file) return notFound(reply);
    const file = path.join(config.dataDir, 'audio', path.basename(t.audio_file)); // el nombre sale de la base de datos, nunca del usuario
    let size;
    try { size = fs.statSync(file).size; } catch { return notFound(reply); }

    reply.header('Content-Type', 'audio/mp4').header('Accept-Ranges', 'bytes').header('Cache-Control', 'private, max-age=3600');
    const range = req.headers.range;
    if (!range) return reply.header('Content-Length', size).send(fs.createReadStream(file));
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === '' && m[2] === '')) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    let start, end;
    if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
    else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
    if (start > end || start >= size) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1)
      .send(fs.createReadStream(file, { start, end }));
  });

  app.get('/api/cover/:id/:variant', guard, async (req, reply) => {
    const id = intParam(req.params.id);
    const { variant } = req.params;
    if (Number.isNaN(id) || !covers.variants.includes(variant)) return bad(reply);
    const album = lib.albumForCover(id);
    if (!album) return notFound(reply);
    let file = null;
    try { file = await covers.get(album, variant); } catch (err) { req.log.warn({ err: err.message, album: id }, 'carátula no disponible'); }
    if (!file) return notFound(reply);
    return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'private, max-age=31536000, immutable').send(fs.createReadStream(file));
  });

  // ---------- favoritos y recientes ----------
  app.get('/api/favorites', guard, async (req) => ({ tracks: lib.favorites(req.user.id) }));
  app.put('/api/favorites/:id', guard, async (req, reply) => {
    const id = intParam(req.params.id);
    if (Number.isNaN(id) || !lib.trackForStream(id)) return notFound(reply);
    db.prepare('INSERT OR IGNORE INTO favorites(user_id, track_id, created_at) VALUES(?,?,?)').run(req.user.id, id, now());
    return { ok: true };
  });
  app.delete('/api/favorites/:id', guard, async (req, reply) => {
    const id = intParam(req.params.id);
    if (Number.isNaN(id)) return bad(reply);
    db.prepare('DELETE FROM favorites WHERE user_id=? AND track_id=?').run(req.user.id, id);
    return { ok: true };
  });

  app.post('/api/plays', guard, async (req, reply) => {
    const id = intParam(req.body?.trackId);
    if (Number.isNaN(id) || !lib.trackForStream(id)) return bad(reply);
    db.prepare('INSERT INTO plays(user_id, track_id, played_at) VALUES(?,?,?)').run(req.user.id, id, now());
    db.prepare('DELETE FROM plays WHERE user_id=? AND id NOT IN (SELECT id FROM plays WHERE user_id=? ORDER BY id DESC LIMIT 500)').run(req.user.id, req.user.id);
    return { ok: true };
  });
  app.get('/api/recents', guard, async (req) => ({ tracks: lib.recents(req.user.id) }));

  // ---------- listas de reproducción ----------
  const ownPlaylist = (req, reply) => {
    const id = intParam(req.params.id);
    if (Number.isNaN(id)) { bad(reply); return null; }
    const row = db.prepare('SELECT id FROM playlists WHERE id=? AND user_id=?').get(id, req.user.id);
    if (!row) { notFound(reply); return null; }
    return id;
  };
  const cleanName = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);

  app.get('/api/playlists', guard, async (req) => ({ playlists: lib.playlists(req.user.id) }));
  app.post('/api/playlists', guard, async (req, reply) => {
    const name = cleanName(req.body?.name);
    if (!name) return bad(reply, 'nombre_vacio');
    const count = db.prepare('SELECT COUNT(*) AS n FROM playlists WHERE user_id=?').get(req.user.id).n;
    if (count >= 100) return bad(reply, 'demasiadas_listas');
    const info = db.prepare('INSERT INTO playlists(user_id,name,created_at) VALUES(?,?,?)').run(req.user.id, name, now());
    return reply.code(201).send({ id: Number(info.lastInsertRowid), name });
  });
  app.get('/api/playlists/:id', guard, async (req, reply) => {
    const id = intParam(req.params.id);
    if (Number.isNaN(id)) return bad(reply);
    return lib.playlist(req.user.id, id) || notFound(reply);
  });
  app.patch('/api/playlists/:id', guard, async (req, reply) => {
    const id = ownPlaylist(req, reply); if (id == null) return;
    const name = cleanName(req.body?.name);
    if (!name) return bad(reply, 'nombre_vacio');
    db.prepare('UPDATE playlists SET name=? WHERE id=?').run(name, id);
    return { ok: true };
  });
  app.delete('/api/playlists/:id', guard, async (req, reply) => {
    const id = ownPlaylist(req, reply); if (id == null) return;
    db.prepare('DELETE FROM playlists WHERE id=?').run(id);
    return { ok: true };
  });
  app.post('/api/playlists/:id/tracks', guard, async (req, reply) => {
    const id = ownPlaylist(req, reply); if (id == null) return;
    const raw = Array.isArray(req.body?.trackIds) ? req.body.trackIds : [req.body?.trackId];
    const ids = raw.map(intParam).filter((n) => !Number.isNaN(n)).slice(0, 500);
    if (!ids.length) return bad(reply);
    let pos = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM playlist_tracks WHERE playlist_id=?').get(id).p;
    const ins = db.prepare('INSERT OR IGNORE INTO playlist_tracks(playlist_id, track_id, position) VALUES(?,?,?)');
    let added = 0;
    for (const t of ids) {
      if (!lib.trackForStream(t)) continue;
      added += Number(ins.run(id, t, pos + 1).changes);
      pos += 1;
    }
    return { ok: true, added };
  });
  app.delete('/api/playlists/:id/tracks/:trackId', guard, async (req, reply) => {
    const id = ownPlaylist(req, reply); if (id == null) return;
    const t = intParam(req.params.trackId);
    if (Number.isNaN(t)) return bad(reply);
    db.prepare('DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?').run(id, t);
    return { ok: true };
  });
}
