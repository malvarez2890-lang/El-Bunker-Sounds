// Consultas de la biblioteca (canciones, álbumes, artistas) ya listas para enviar al navegador.
import { norm } from './util.js';

const TRACK_SQL = `SELECT t.id, t.title, t.track_no AS trackNo, t.duration, t.album_id AS albumId, al.title AS albumTitle, al.kind,
  t.artist_id AS artistId, ar.name AS artistName, (t.audio_status = 'ok') AS ready, (al.cover_rel IS NOT NULL) AS hasCover,
  al.cover_mtime AS coverV, EXISTS(SELECT 1 FROM favorites f WHERE f.user_id = ? AND f.track_id = t.id) AS fav
  FROM tracks t JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = t.artist_id
  WHERE t.missing = 0 AND al.missing = 0 AND ar.missing = 0`;

const ALBUM_SQL = `SELECT al.id, al.title, al.kind, al.artist_id AS artistId, ar.name AS artistName,
  (al.cover_rel IS NOT NULL) AS hasCover, (al.back_rel IS NOT NULL) AS hasBack, al.cover_mtime AS coverV, al.back_mtime AS backV,
  (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id AND t.missing = 0) AS trackCount,
  (SELECT COALESCE(SUM(t.duration), 0) FROM tracks t WHERE t.album_id = al.id AND t.missing = 0) AS duration
  FROM albums al JOIN artists ar ON ar.id = al.artist_id WHERE al.missing = 0 AND ar.missing = 0`;

const fixTrack = (r) => ({ ...r, ready: !!r.ready, hasCover: !!r.hasCover, fav: !!r.fav });
const fixAlbum = (r) => ({ ...r, hasCover: !!r.hasCover, hasBack: !!r.hasBack });
const like = (s) => `%${s.replace(/[\\%_]/g, (c) => '\\' + c)}%`;

export function createLibraryQueries(db) {
  const tracks = (uid, where = '', params = [], tail = '') =>
    db.prepare(`${TRACK_SQL} ${where} ${tail}`).all(uid, ...params).map(fixTrack);
  const albums = (where = '', params = [], tail = '') =>
    db.prepare(`${ALBUM_SQL} ${where} ${tail}`).all(...params).map(fixAlbum);

  const ORDER_ALBUM_TRACKS = 'ORDER BY COALESCE(t.track_no, 1000000), t.title COLLATE NOCASE';
  const NEWEST_ALBUMS = 'ORDER BY al.added_at DESC, COALESCE(al.order_no, 0) DESC, al.id DESC';

  return {
    tracks, albums,

    album(uid, id) {
      const [album] = albums('AND al.id = ?', [id]);
      if (!album) return null;
      return { ...album, tracks: tracks(uid, 'AND t.album_id = ?', [id], ORDER_ALBUM_TRACKS) };
    },

    allAlbums(kind) {
      return kind ? albums('AND al.kind = ?', [kind], NEWEST_ALBUMS) : albums('', [], NEWEST_ALBUMS);
    },

    artists() {
      return db.prepare(`SELECT ar.id, ar.name,
        (SELECT COUNT(*) FROM albums al WHERE al.artist_id = ar.id AND al.missing = 0) AS albumCount,
        (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = ar.id AND t.missing = 0) AS trackCount,
        (SELECT al.id FROM albums al WHERE al.artist_id = ar.id AND al.missing = 0 AND al.cover_rel IS NOT NULL
           ORDER BY al.added_at DESC, COALESCE(al.order_no,0) DESC LIMIT 1) AS coverAlbumId
        FROM artists ar WHERE ar.missing = 0 ORDER BY ar.name COLLATE NOCASE`).all();
    },

    artist(uid, id) {
      const row = db.prepare('SELECT id, name FROM artists WHERE id = ? AND missing = 0').get(id);
      if (!row) return null;
      const list = albums('AND al.artist_id = ?', [id], NEWEST_ALBUMS);
      return {
        ...row, albums: list,
        trackCount: list.reduce((n, a) => n + a.trackCount, 0),
        tracks: tracks(uid, 'AND t.artist_id = ?', [id], 'ORDER BY al.added_at DESC, COALESCE(al.order_no,0) DESC, COALESCE(t.track_no,1000000), t.title COLLATE NOCASE'),
      };
    },

    byIds(uid, ids) {
      if (!ids.length) return [];
      const rows = tracks(uid, `AND t.id IN (${ids.map(() => '?').join(',')})`, ids);
      const by = new Map(rows.map((r) => [r.id, r]));
      return ids.map((i) => by.get(i)).filter(Boolean); // conserva el orden pedido
    },

    search(uid, q) {
      const tokens = norm(q).split(/\s+/).filter(Boolean).slice(0, 6);
      if (!tokens.length) return { tracks: [], albums: [], artists: [] };
      const cond = (col) => tokens.map(() => `${col} LIKE ? ESCAPE '\\'`).join(' AND ');
      const p = tokens.map(like);
      return {
        tracks: tracks(uid, `AND ${cond('t.search')}`, p, 'ORDER BY t.title COLLATE NOCASE LIMIT 30'),
        albums: albums(`AND ${cond('al.search')}`, p, 'ORDER BY al.title COLLATE NOCASE LIMIT 20'),
        artists: db.prepare(`SELECT ar.id, ar.name,
          (SELECT al.id FROM albums al WHERE al.artist_id = ar.id AND al.missing = 0 AND al.cover_rel IS NOT NULL LIMIT 1) AS coverAlbumId
          FROM artists ar WHERE ar.missing = 0 AND ${cond('ar.search')} ORDER BY ar.name COLLATE NOCASE LIMIT 10`).all(...p),
      };
    },

    favorites(uid) {
      return tracks(uid, 'AND t.id IN (SELECT track_id FROM favorites WHERE user_id = ?)', [uid],
        'ORDER BY (SELECT created_at FROM favorites f WHERE f.user_id = ' + Number(uid) + ' AND f.track_id = t.id) DESC');
    },

    recents(uid, limit = 50) {
      const ids = db.prepare(`SELECT p.track_id AS id, MAX(p.id) AS last FROM plays p JOIN tracks t ON t.id = p.track_id
        WHERE p.user_id = ? AND t.missing = 0 GROUP BY p.track_id ORDER BY last DESC LIMIT ?`).all(uid, limit).map((r) => r.id);
      return this.byIds(uid, ids);
    },

    recentAlbums(uid, limit = 12) {
      const ids = db.prepare(`SELECT t.album_id AS id, MAX(p.id) AS last FROM plays p JOIN tracks t ON t.id = p.track_id
        WHERE p.user_id = ? AND t.missing = 0 GROUP BY t.album_id ORDER BY last DESC LIMIT ?`).all(uid, limit).map((r) => r.id);
      if (!ids.length) return [];
      const rows = albums(`AND al.id IN (${ids.map(() => '?').join(',')})`, ids);
      const by = new Map(rows.map((r) => [r.id, r]));
      return ids.map((i) => by.get(i)).filter(Boolean);
    },

    playlists(uid) {
      const rows = db.prepare(`SELECT p.id, p.name,
        (SELECT COUNT(*) FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = p.id AND t.missing = 0) AS trackCount
        FROM playlists p WHERE p.user_id = ? ORDER BY p.created_at DESC, p.id DESC`).all(uid);
      const coverStmt = db.prepare(`SELECT DISTINCT t.album_id AS id FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
        JOIN albums al ON al.id = t.album_id WHERE pt.playlist_id = ? AND t.missing = 0 AND al.cover_rel IS NOT NULL
        ORDER BY pt.position LIMIT 4`);
      return rows.map((r) => ({ ...r, covers: coverStmt.all(r.id).map((c) => c.id) }));
    },

    playlist(uid, id) {
      const row = db.prepare('SELECT id, name FROM playlists WHERE id = ? AND user_id = ?').get(id, uid);
      if (!row) return null;
      return {
        ...row,
        tracks: tracks(uid, 'AND t.id IN (SELECT track_id FROM playlist_tracks WHERE playlist_id = ?)', [id],
          `ORDER BY (SELECT position FROM playlist_tracks pt WHERE pt.playlist_id = ${Number(id)} AND pt.track_id = t.id)`),
      };
    },

    albumForCover(id) {
      return db.prepare('SELECT id, cover_rel, cover_mtime, back_rel, back_mtime FROM albums WHERE id = ? AND missing = 0').get(id);
    },

    trackForStream(id) {
      return db.prepare('SELECT id, audio_file, audio_status FROM tracks WHERE id = ? AND missing = 0').get(id);
    },
  };
}
