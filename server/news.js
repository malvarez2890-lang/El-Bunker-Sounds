// Novedades: tarjetas que el administrador publica en Inicio (por ejemplo, "próximo lanzamiento").
import { now } from './util.js';

export function createNews({ db, lib }) {
  const view = (r) => {
    const album = r.album_id ? lib.albums('AND al.id = ?', [r.album_id])[0] || null : null;
    return {
      id: r.id, title: r.title, body: r.body, active: !!r.active, createdAt: r.created_at, updatedAt: r.updated_at,
      album: album && { id: album.id, title: album.title, artistName: album.artistName, hasCover: album.hasCover, coverV: album.coverV, releaseDate: album.releaseDate, trackCount: album.trackCount, totalCount: album.totalCount },
    };
  };
  const clean = (b = {}) => {
    const title = String(b.title ?? '').trim().slice(0, 80);
    const body = String(b.body ?? '').trim().slice(0, 500);
    const albumId = Number.isInteger(b.albumId) && b.albumId > 0 && lib.albums('AND al.id = ?', [b.albumId]).length ? b.albumId : null;
    return { title, body, albumId, active: b.active === undefined ? undefined : (b.active ? 1 : 0) };
  };
  return {
    list({ all = false } = {}) {
      const rows = db.prepare(`SELECT * FROM news ${all ? '' : 'WHERE active = 1'} ORDER BY created_at DESC, id DESC LIMIT ${all ? 100 : 5}`).all();
      return rows.map(view);
    },
    get(id) { const r = db.prepare('SELECT * FROM news WHERE id = ?').get(id); return r ? view(r) : null; },
    create(b) {
      const c = clean(b);
      if (!c.title) return null;
      const id = Number(db.prepare('INSERT INTO news(title, body, album_id, active, created_at, updated_at) VALUES(?,?,?,?,?,?)')
        .run(c.title, c.body, c.albumId, c.active ?? 1, now(), now()).lastInsertRowid);
      return this.get(id);
    },
    update(id, b) {
      const cur = db.prepare('SELECT * FROM news WHERE id = ?').get(id);
      if (!cur) return null;
      const c = clean({ title: b.title ?? cur.title, body: b.body ?? cur.body, albumId: b.albumId === undefined ? cur.album_id : b.albumId, active: b.active });
      if (!c.title) return undefined;
      db.prepare('UPDATE news SET title=?, body=?, album_id=?, active=?, updated_at=? WHERE id=?').run(c.title, c.body, c.albumId, c.active ?? cur.active, now(), id);
      return this.get(id);
    },
    remove(id) { return Number(db.prepare('DELETE FROM news WHERE id = ?').run(id).changes) > 0; },
  };
}
