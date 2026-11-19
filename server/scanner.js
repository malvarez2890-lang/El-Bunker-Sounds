// Recorre la carpeta de música y llena la biblioteca.
// Estructura esperada:  Artista/<Artista>/{Albums,EPs,Singles}/<Álbum>/NN. Título.wav + PORTADA.png + CONTRAPORTADA.png
// (también acepta carpetas de álbum directo dentro del artista, y archivos sueltos).
import fs from 'node:fs/promises';
import path from 'node:path';
import { tx } from './db.js';
import { norm, nfc, now } from './util.js';

const AUDIO_EXT = new Set(['.wav', '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const IGNORED = /^(\.|~\$|desktop\.ini$|thumbs\.db$|\$recycle\.bin$|@eadir$)/i;
const KIND_DIRS = { albums: 'album', albumes: 'album', album: 'album', ep: 'ep', eps: 'ep', singles: 'single', single: 'single', sencillos: 'single' };
const FRONT_NAMES = new Set(['portada', 'cover', 'front', 'folder', 'album', 'frontal', 'caratula']);
const BACK_NAMES = new Set(['contraportada', 'contratapa', 'back', 'contracover', 'trasera']);

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

const MONTHS = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const pad2 = (n) => String(n).padStart(2, '0');
/** "2026-11-21", "21/11/2026" o "21 de noviembre de 2026" → "2026-11-21" (o null). */
export function parseDateText(text) {
  const t = norm(text).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  m = /^(\d{1,2})\s+(?:de\s+)?([a-z]+)(?:\s+(?:de(?:l)?\s+)?(\d{4}))?$/.exec(t);
  if (m && MONTHS[m[2]]) return `${m[3] || new Date().getFullYear()}-${pad2(MONTHS[m[2]])}-${pad2(m[1])}`;
  return null;
}

/** El Bloc de notas puede guardar en UTF-16 ("Unicode"): se detecta por su marca inicial y se convierte. */
export function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  return buf.toString('utf8');
}

/**
 * Lee un TRACKLIST.txt: una línea por canción ("01. Título"), y opcionalmente "Lanzamiento: 21 de noviembre de 2026".
 * Las líneas vacías, las que empiezan con # y las que no tienen número se ignoran.
 */
export function parseTracklist(text) {
  const entries = [];
  const available = []; // números de las canciones que se pueden escuchar ANTES de la fecha de lanzamiento (los singles)
  let releaseDate = null;
  for (const raw of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const kv = /^(fecha\s+de\s+lanzamiento|lanzamiento|fecha|release)\s*[:=]\s*(.+)$/i.exec(line);
    if (kv) { releaseDate = parseDateText(kv[2]) || releaseDate; continue; }
    const av = /^((?:ya\s+)?disponibles?(?:\s+ya|\s+desde\s+ya)?|singles?|sencillos?)\s*[:=]\s*(.+)$/i.exec(line);
    if (av) { for (const n of av[2].match(/\d{1,3}/g) || []) available.push(Number(n)); continue; }
    const m = /^(\d{1,3})\s*[.\-_)]\s*(.+)$/.exec(line);
    if (m) entries.push({ no: Number(m[1]), title: nfc(m[2].trim()) });
  }
  return { entries, releaseDate, available };
}
const looseKey = (s) => norm(s).replace(/[^a-z0-9]+/g, '');

/** "01. Título" → { no: 1, title: "Título" }.  "3.17" (sin espacio) no cuenta como número. */
export function parseNumbered(name) {
  const m = /^\s*(\d{1,3})\s*(?:[.\-_)]\s+|\s-\s*)(.+?)\s*$/.exec(name);
  if (m) return { no: Number(m[1]), title: m[2] };
  return { no: null, title: name.trim() };
}

async function listDir(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !IGNORED.test(e.name) && !e.isSymbolicLink()) // los enlaces simbólicos se ignoran por seguridad
    .sort((a, b) => collator.compare(a.name, b.name));
}

const extOf = (name) => path.extname(name).toLowerCase();
const stem = (name) => name.slice(0, name.length - path.extname(name).length);

async function statOf(file) {
  const st = await fs.stat(file);
  return { size: st.size, mtime: Math.floor(st.mtimeMs) };
}

/** Lee una carpeta de álbum y devuelve el lanzamiento (o null si no tiene audio). */
async function readAlbumDir(root, relDir, kind, artistName) {
  const abs = path.join(root, relDir);
  const entries = await listDir(abs);
  const files = entries.filter((e) => e.isFile());
  const audio = files.filter((f) => AUDIO_EXT.has(extOf(f.name)));
  if (!audio.length) return null;

  const images = files.filter((f) => IMAGE_EXT.has(extOf(f.name)));
  const front = images.find((f) => FRONT_NAMES.has(norm(stem(f.name)).trim()));
  const back = images.find((f) => BACK_NAMES.has(norm(stem(f.name)).trim()));

  const folderName = path.basename(relDir);
  const { no, title } = parseNumbered(nfc(folderName));
  const tracks = [];
  for (const f of audio) {
    const rel = path.join(relDir, f.name);
    const st = await statOf(path.join(root, rel));
    const parsed = parseNumbered(nfc(stem(f.name)));
    tracks.push({ srcRel: rel, title: parsed.title, trackNo: parsed.no, ...st });
  }
  // Orden: primero los que traen número, luego por nombre.
  tracks.sort((a, b) => (a.trackNo ?? 1e6) - (b.trackNo ?? 1e6) || collator.compare(a.title, b.title));

  // TRACKLIST.txt: canciones "por salir". Las que tienen archivo se escuchan; el resto aparece en gris ("disponible pronto").
  let releaseDate = null;
  let tracklistInfo = null; // lo que se entendió del TRACKLIST.txt (para el comando de revisión)
  const tl = files.find((f) => f.name.toLowerCase() === 'tracklist.txt');
  if (tl) {
    try {
      const st = await fs.stat(path.join(abs, tl.name));
      if (st.size <= 64 * 1024) {
        const parsed = parseTracklist(decodeText(await fs.readFile(path.join(abs, tl.name))));
        releaseDate = parsed.releaseDate;
        tracklistInfo = { entries: parsed.entries.length, releaseDate: parsed.releaseDate, available: parsed.available };
        const taken = new Set();
        const drop = new Set();
        for (const e of parsed.entries) {
          // Puede haber dos archivos para la misma canción (por ejemplo, la versión con el nombre viejo y la nueva, porque la copia a
          // tu servidor solo agrega archivos). Se elige UNO: el que se llama como dice la lista y, si empatan, el más reciente.
          const cands = tracks.filter((t) => !taken.has(t) && (t.trackNo === e.no || looseKey(t.title) === looseKey(e.title)));
          cands.sort((a, b) => (looseKey(b.title) === looseKey(e.title)) - (looseKey(a.title) === looseKey(e.title)) || (b.mtime ?? 0) - (a.mtime ?? 0));
          const real = cands[0];
          if (real) {
            taken.add(real); real.title = e.title; real.trackNo = e.no; for (const other of cands.slice(1)) drop.add(other);
            // Programada: tiene archivo, pero no se escucha hasta la fecha (salvo las que la lista deja disponibles desde ya).
            if (releaseDate && parsed.available.length && !parsed.available.includes(e.no)) real.releaseDate = releaseDate;
          } // el título de la lista es el "oficial"
          else tracks.push({ srcRel: path.join(relDir, `#por-salir-${pad2(e.no)}`), title: e.title, trackNo: e.no, upcoming: true });
        }
        for (let i = tracks.length - 1; i >= 0; i--) if (drop.has(tracks[i])) tracks.splice(i, 1); // las versiones repetidas no se muestran (el archivo queda en disco)
        tracks.sort((a, b) => (a.trackNo ?? 1e6) - (b.trackNo ?? 1e6) || collator.compare(a.title, b.title));
      }
    } catch { /* un TRACKLIST.txt ilegible se ignora */ }
  }

  const release = { folderRel: relDir, kind, title, orderNo: no, artistName, tracks, releaseDate, tracklist: tl ? (tracklistInfo || { unreadable: true }) : null, coverRel: null, backRel: null };
  if (front) {
    release.coverRel = path.join(relDir, front.name);
    release.coverMtime = (await statOf(path.join(root, release.coverRel))).mtime;
  }
  if (back) {
    release.backRel = path.join(relDir, back.name);
    release.backMtime = (await statOf(path.join(root, release.backRel))).mtime;
  }
  return release;
}

/** Un archivo suelto dentro de Singles/ es un sencillo de una sola canción. */
async function readLooseSingle(root, relDir, file, siblings, artistName) {
  const rel = path.join(relDir, file.name);
  const st = await statOf(path.join(root, rel));
  const parsed = parseNumbered(nfc(stem(file.name)));
  const base = norm(stem(file.name)).trim();
  const img = siblings.find((f) => IMAGE_EXT.has(extOf(f.name)) && norm(stem(f.name)).trim() === base);
  const release = {
    folderRel: rel, kind: 'single', title: parsed.title, orderNo: parsed.no, artistName,
    tracks: [{ srcRel: rel, title: parsed.title, trackNo: 1, ...st }], coverRel: null, backRel: null,
  };
  if (img) {
    release.coverRel = path.join(relDir, img.name);
    release.coverMtime = (await statOf(path.join(root, release.coverRel))).mtime;
  }
  return release;
}

/** Devuelve la lista de artistas con sus lanzamientos, tal como están en disco. */
export async function readLibraryFromDisk(musicDir) {
  let root = musicDir;
  const top = await listDir(root);
  // Si dentro hay una carpeta llamada "Artista(s)", se usa esa como raíz.
  const wrapper = top.find((e) => e.isDirectory() && ['artista', 'artistas', 'artists'].includes(norm(e.name)));
  if (wrapper) root = path.join(musicDir, wrapper.name);
  const artists = [];
  for (const a of await listDir(root)) {
    if (!a.isDirectory()) continue;
    const artistName = nfc(a.name);
    const releases = [];
    for (const child of await listDir(path.join(root, a.name))) {
      const relChild = path.join(a.name, child.name);
      const kind = KIND_DIRS[norm(child.name)];
      if (child.isDirectory() && kind) {
        const kindEntries = await listDir(path.join(root, relChild));
        for (const item of kindEntries) {
          if (item.isDirectory()) {
            const r = await readAlbumDir(root, path.join(relChild, item.name), kind, artistName);
            if (r) releases.push(r);
          } else if (AUDIO_EXT.has(extOf(item.name))) {
            releases.push(await readLooseSingle(root, relChild, item, kindEntries.filter((x) => x.isFile()), artistName));
          }
        }
      } else if (child.isDirectory()) {
        const r = await readAlbumDir(root, relChild, 'album', artistName);
        if (r) releases.push(r);
      }
    }
    if (releases.length) artists.push({ folder: a.name, name: artistName, releases });
  }
  return { root, artists };
}

/** Pone la biblioteca de la base de datos al día con lo que hay en disco. */
export async function scanLibrary({ db, config, log }) {
  const started = Date.now();
  const { root, artists } = await readLibraryFromDisk(config.musicDir);
  // Las rutas se guardan relativas a la carpeta de música (no a la subcarpeta "Artista"), porque desde ahí se leen después.
  const prefix = path.relative(config.musicDir, root);
  const rel = (p) => (p ? path.join(prefix, p) : p);
  const scanId = now() * 1000 + Math.floor(Math.random() * 1000);
  const ts = now();

  const upArtist = db.prepare(`INSERT INTO artists(name, folder, search, seen, missing) VALUES(?,?,?,?,0)
    ON CONFLICT(folder) DO UPDATE SET name=excluded.name, search=excluded.search, seen=excluded.seen, missing=0 RETURNING id`);
  const upAlbum = db.prepare(`INSERT INTO albums(artist_id,title,kind,folder,order_no,cover_rel,cover_mtime,back_rel,back_mtime,added_at,search,seen,release_date,missing)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0)
    ON CONFLICT(folder) DO UPDATE SET artist_id=excluded.artist_id, title=excluded.title, kind=excluded.kind, order_no=excluded.order_no, release_date=excluded.release_date,
      cover_rel=excluded.cover_rel, cover_mtime=excluded.cover_mtime, back_rel=excluded.back_rel, back_mtime=excluded.back_mtime,
      search=excluded.search, seen=excluded.seen, missing=0 RETURNING id`);
  const upTrack = db.prepare(`INSERT INTO tracks(album_id,artist_id,title,track_no,src_rel,src_size,src_mtime,added_at,search,seen,missing,announced,release_date)
    VALUES(?,?,?,?,?,?,?,?,?,?,0,0,?)
    ON CONFLICT(src_rel) DO UPDATE SET album_id=excluded.album_id, artist_id=excluded.artist_id, title=excluded.title, track_no=excluded.track_no,
      search=excluded.search, seen=excluded.seen, missing=0, release_date=excluded.release_date,
      audio_status=CASE WHEN tracks.src_size IS NOT excluded.src_size OR tracks.src_mtime IS NOT excluded.src_mtime THEN 'pending' ELSE tracks.audio_status END,
      audio_file=CASE WHEN tracks.src_size IS NOT excluded.src_size OR tracks.src_mtime IS NOT excluded.src_mtime THEN NULL ELSE tracks.audio_file END,
      audio_error=CASE WHEN tracks.src_size IS NOT excluded.src_size OR tracks.src_mtime IS NOT excluded.src_mtime THEN NULL ELSE tracks.audio_error END,
      src_size=excluded.src_size, src_mtime=excluded.src_mtime`);

  // Canciones "por salir" (sin archivo): estado 'upcoming'. Nunca se convierten ni suenan.
  const upGhost = db.prepare(`INSERT INTO tracks(album_id,artist_id,title,track_no,src_rel,added_at,search,seen,audio_status,missing)
    VALUES(?,?,?,?,?,?,?,?, 'upcoming', 0)
    ON CONFLICT(src_rel) DO UPDATE SET album_id=excluded.album_id, artist_id=excluded.artist_id, title=excluded.title, track_no=excluded.track_no,
      search=excluded.search, seen=excluded.seen, missing=0, audio_status='upcoming'`);

  let trackCount = 0;
  tx(db, () => {
    for (const artist of artists) {
      const artistId = upArtist.get(artist.name, artist.folder, norm(artist.name), scanId).id;
      for (const r of artist.releases) {
        const albumId = upAlbum.get(
          artistId, r.title, r.kind, rel(r.folderRel), r.orderNo, rel(r.coverRel), r.coverMtime ?? null,
          rel(r.backRel), r.backMtime ?? null, ts, norm(`${r.title} ${artist.name}`), scanId, r.releaseDate ?? null,
        ).id;
        for (const t of r.tracks) {
          if (t.upcoming) { upGhost.run(albumId, artistId, t.title, t.trackNo, rel(t.srcRel), ts, norm(`${t.title} ${artist.name} ${r.title}`), scanId); continue; }
          upTrack.run(albumId, artistId, t.title, t.trackNo, rel(t.srcRel), t.size, t.mtime, ts,
            norm(`${t.title} ${artist.name} ${r.title}`), scanId, t.releaseDate ?? null);
          trackCount++;
        }
      }
    }
    // Lo que ya no está en disco se oculta (no se borra, para no perder favoritos si el archivo vuelve).
    db.prepare('UPDATE tracks SET missing=1 WHERE seen != ?').run(scanId);
    db.prepare('UPDATE albums SET missing=1 WHERE seen != ?').run(scanId);
    db.prepare('UPDATE artists SET missing=1 WHERE seen != ?').run(scanId);
  });
  const summary = { root, artists: artists.length, tracks: trackCount, ms: Date.now() - started };
  log?.info?.(summary, 'escaneo de biblioteca terminado');
  return summary;
}
