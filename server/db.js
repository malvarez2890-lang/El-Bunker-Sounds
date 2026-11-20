import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
  `
  CREATE TABLE artists (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    folder TEXT NOT NULL UNIQUE,
    search TEXT NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0,
    missing INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE albums (
    id INTEGER PRIMARY KEY,
    artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,                -- album | ep | single
    folder TEXT NOT NULL UNIQUE,       -- ruta relativa dentro de la carpeta de música
    order_no INTEGER,
    cover_rel TEXT, cover_mtime INTEGER,
    back_rel TEXT, back_mtime INTEGER,
    added_at INTEGER NOT NULL,
    search TEXT NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0,
    missing INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX albums_artist ON albums(artist_id);
  CREATE TABLE tracks (
    id INTEGER PRIMARY KEY,
    album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    track_no INTEGER,
    src_rel TEXT NOT NULL UNIQUE,
    src_size INTEGER, src_mtime INTEGER,
    duration REAL,
    audio_status TEXT NOT NULL DEFAULT 'pending',  -- pending | ok | error
    audio_file TEXT,
    audio_error TEXT,
    added_at INTEGER NOT NULL,
    search TEXT NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0,
    missing INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX tracks_album ON tracks(album_id);
  CREATE INDEX tracks_status ON tracks(audio_status);

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    google_sub TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',        -- pending | active | blocked
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen INTEGER
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,                           -- sha256 del token (el token real solo vive en la cookie)
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE login_codes (
    email TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_count INTEGER NOT NULL DEFAULT 0,
    window_start INTEGER NOT NULL
  );

  CREATE TABLE favorites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_id)
  );
  CREATE TABLE playlists (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX playlists_user ON playlists(user_id);
  CREATE TABLE playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id)
  );
  CREATE TABLE plays (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    played_at INTEGER NOT NULL
  );
  CREATE INDEX plays_user ON plays(user_id, played_at DESC);
  `,
  // 2: álbumes con canciones "por salir" (fecha del lanzamiento completo)
  `
  ALTER TABLE albums ADD COLUMN release_date TEXT;
  `,
  // 3: novedades (tarjetas en Inicio, las crea el administrador)
  `
  CREATE TABLE news (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    album_id INTEGER REFERENCES albums(id) ON DELETE SET NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // 4: avisos al celular (Web Push), ajustes y "música nueva ya avisada"
  `
  CREATE TABLE push_subs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX push_subs_user ON push_subs(user_id);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  ALTER TABLE tracks ADD COLUMN announced INTEGER NOT NULL DEFAULT 1; -- 0 = canción nueva todavía sin avisar
  `,
  // 5: canciones con archivo pero "programadas": no se escuchan hasta su fecha de lanzamiento (YYYY-MM-DD)
  `
  ALTER TABLE tracks ADD COLUMN release_date TEXT;
  `,
  // 6: novedades "próximamente" (tarjeta destacada arriba de todo)
  `
  ALTER TABLE news ADD COLUMN soon INTEGER NOT NULL DEFAULT 0;
  `,
  // 7: lanzamientos avisados (por correo y celular) una sola vez por álbum
  `
  ALTER TABLE albums ADD COLUMN launched INTEGER NOT NULL DEFAULT 0;
  `,
];

/** La fecha de hoy (YYYY-MM-DD) en la zona horaria de la app. Para pruebas se puede forzar con EBS_FAKE_TODAY. */
export const todayIn = (tz) => process.env.EBS_FAKE_TODAY || new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

export function openDb(dataDir, tz = 'America/Santiago') {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'bunker.db'));
  db.function('ebs_today', () => todayIn(tz)); // las canciones programadas se liberan solas al llegar su fecha, sin reiniciar nada
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version=${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

/** Ejecuta fn dentro de una transacción. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
