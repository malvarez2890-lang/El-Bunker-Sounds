// Conversión de audio (WAV → M4A/AAC) y carátulas reducidas, usando ffmpeg.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { safeRealPath } from './safe-path.js';

const HAS_NICE = ['/usr/bin/nice', '/bin/nice'].some((p) => fs.existsSync(p));

function run(cmd, args, { timeoutMs = 10 * 60 * 1000, lowPriority = false } = {}) {
  return new Promise((resolve, reject) => {
    const useNice = lowPriority && HAS_NICE;
    const child = spawn(useNice ? 'nice' : cmd, useNice ? ['-n', '19', cmd, ...args] : args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').slice(-3).join(' | ') || `${cmd} terminó con código ${code}`));
    });
  });
}

export async function probeDuration(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeoutMs: 60000 });
  const d = parseFloat(out);
  return Number.isFinite(d) ? d : null;
}

/**
 * Convierte la música a MP3 320k (una sola copia para el teléfono Y para el Onkyo), de a una y con prioridad baja
 * (el servidor comparte CPU con Valheim). Orden: lo que se pide para sonar YA, luego lo nuevo, y al final se pasan a MP3
 * las canciones que aún están en M4A de la versión anterior (siguen sonando mientras tanto).
 */
export function createTranscoder({ db, config, log }) {
  const audioDir = path.join(config.dataDir, 'audio');
  const legacyMp3Dir = path.join(config.dataDir, 'onkyo-mp3'); // copias MP3 que hizo la versión anterior solo para el Onkyo: se aprovechan
  fs.mkdirSync(audioDir, { recursive: true });
  let running = false;
  let again = false;
  let current = null;
  const urgent = [];            // ids pedidos para sonar ya
  const waiters = new Map();    // id -> [{resolve, reject}]
  const failedMigration = new Set(); // canciones M4A que no se pudieron pasar a MP3: no se reintentan en bucle

  const isMp3 = (f) => !!f && f.endsWith('.mp3');

  async function convert(t) {
    current = t.id;
    const name = `${t.id}-${t.mtime}.mp3`;
    const out = path.join(audioDir, name);
    let have = false;
    try { have = fs.statSync(out).size > 0; } catch { /* no existe */ }
    if (!have) {
      const legacy = path.join(legacyMp3Dir, name); // mismo nombre: se mueve sin volver a convertir
      let moved = false;
      try { if (fs.statSync(legacy).size > 0) { await fsp.rename(legacy, out); moved = true; } } catch { /* no hay */ }
      if (!moved) {
        const src = await safeRealPath(config.musicDir, t.rel);
        if (!src) throw new Error('ruta de origen no permitida o archivo no encontrado');
        const tmp = `${out}.tmp.mp3`;
        await run('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-i', src, '-vn', '-map_metadata', '-1', '-ac', '2', '-ar', '44100',
          '-c:a', 'libmp3lame', '-b:a', config.mp3Bitrate, '-threads', '1', '-f', 'mp3', tmp], { lowPriority: true });
        await fsp.rename(tmp, out);
      }
    }
    const duration = await probeDuration(out);
    db.prepare("UPDATE tracks SET audio_status='ok', audio_file=?, duration=?, audio_error=NULL WHERE id=?").run(name, duration, t.id);
    return out;
  }

  const rowById = (id) => db.prepare('SELECT id, src_rel AS rel, src_mtime AS mtime FROM tracks WHERE id=? AND missing=0').get(id);
  function pickNext() {
    while (urgent.length) { const t = rowById(urgent.shift()); if (t) return { t, kind: 'urgent' }; }
    const p = db.prepare(`SELECT id, src_rel AS rel, src_mtime AS mtime FROM tracks
      WHERE audio_status='pending' AND missing=0 ORDER BY album_id, track_no, id LIMIT 1`).get();
    if (p) return { t: p, kind: 'pending' };
    const legacy = db.prepare(`SELECT id, src_rel AS rel, src_mtime AS mtime FROM tracks
      WHERE audio_status='ok' AND missing=0 AND (audio_file IS NULL OR audio_file NOT LIKE '%.mp3') ORDER BY album_id, track_no, id`).all()
      .find((r) => !failedMigration.has(r.id));
    return legacy ? { t: legacy, kind: 'legacy' } : null;
  }

  async function loop() {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        for (let job = pickNext(); job; job = pickNext()) {
          const { t, kind } = job;
          const ws = waiters.get(t.id) || [];
          waiters.delete(t.id);
          try {
            const out = await convert(t);
            ws.forEach((w) => w.resolve(out));
          } catch (err) {
            log?.warn?.({ track: t.id, err: err.message, kind }, 'no se pudo convertir una canción');
            if (kind === 'legacy') failedMigration.add(t.id); // sigue sonando en M4A
            else db.prepare("UPDATE tracks SET audio_status='error', audio_error=? WHERE id=?").run(String(err.message).slice(0, 400), t.id);
            ws.forEach((w) => w.reject(err));
          }
        }
      } while (again);
    } finally {
      running = false;
      current = null;
    }
  }

  const pathOf = (id) => {
    const r = db.prepare('SELECT audio_file FROM tracks WHERE id=? AND missing=0').get(id);
    return r && isMp3(r.audio_file) ? path.join(audioDir, path.basename(r.audio_file)) : null;
  };

  return {
    kick() { loop().catch((e) => log?.error?.(e)); },
    idle: () => !running,
    async whenIdle() { while (running) await new Promise((r) => setTimeout(r, 50)); },
    /** Ruta del MP3 de una canción si ya existe. */
    mp3PathIfReady: pathOf,
    /** Devuelve el MP3 de una canción, convirtiéndola ya (pasa adelante de la fila) si todavía no está. */
    async ensureMp3(id) {
      const have = pathOf(id);
      if (have) return have;
      if (!rowById(id)) throw new Error('canción no encontrada');
      failedMigration.delete(id);
      return new Promise((resolve, reject) => {
        waiters.set(id, [...(waiters.get(id) || []), { resolve, reject }]);
        if (!urgent.includes(id)) urgent.unshift(id);
        this.kick();
      });
    },
    /** Deja lista una canción sin esperar (la siguiente de la cola del Onkyo). */
    prefetchMp3(id) { if (!pathOf(id) && rowById(id)) { failedMigration.delete(id); if (!urgent.includes(id)) urgent.push(id); this.kick(); } },
    status() {
      const rows = db.prepare('SELECT audio_status AS s, COUNT(*) AS n FROM tracks WHERE missing=0 GROUP BY audio_status').all();
      const by = Object.fromEntries(rows.map((r) => [r.s, r.n]));
      const legacy = Number(db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE missing=0 AND audio_status='ok' AND (audio_file IS NULL OR audio_file NOT LIKE '%.mp3')").get().n);
      return { ok: by.ok || 0, pending: by.pending || 0, error: by.error || 0, converting: current, legacy };
    },
    retryErrors() {
      return Number(db.prepare("UPDATE tracks SET audio_status='pending', audio_error=NULL WHERE audio_status='error'").run().changes);
    },
    /** Borra copias que ya no sirven (canciones borradas, reemplazadas, o los M4A viejos ya pasados a MP3). Nunca toca tus WAV. */
    async cleanup() {
      const keep = new Set(db.prepare("SELECT audio_file AS f FROM tracks WHERE audio_file IS NOT NULL").all().map((r) => r.f));
      for (const f of await fsp.readdir(audioDir)) {
        const full = path.join(audioDir, f);
        const st = await fsp.stat(full).catch(() => null);
        if (st && !keep.has(f) && Date.now() - st.mtimeMs > 10 * 60 * 1000) await fsp.unlink(full).catch(() => {});
      }
    },
  };
}

const COVER_SIZES = { s: 240, m: 640, l: 1200, back: 1000 };

/** Carátulas reducidas, creadas la primera vez que se piden y guardadas en caché. */
export function createCovers({ config }) {
  const dir = path.join(config.dataDir, 'covers');
  fs.mkdirSync(dir, { recursive: true });
  const inflight = new Map();

  async function build(album, variant) {
    const isBack = variant === 'back';
    const rel = isBack ? album.back_rel : album.cover_rel;
    if (!rel) return null;
    const mtime = (isBack ? album.back_mtime : album.cover_mtime) || 0;
    const out = path.join(dir, `${album.id}-${variant}-${mtime}.jpg`);
    if (fs.existsSync(out)) return out;
    const src = await safeRealPath(config.musicDir, rel);
    if (!src) return null;
    const size = COVER_SIZES[variant];
    const tmp = `${out}.tmp.jpg`;
    await run('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-i', src, '-frames:v', '1',
      '-vf', `scale='min(${size},iw)':-2:flags=lanczos`, '-q:v', '3', tmp], { timeoutMs: 60000, lowPriority: true });
    await fsp.rename(tmp, out);
    return out;
  }

  return {
    variants: Object.keys(COVER_SIZES),
    get(album, variant) {
      const key = `${album.id}-${variant}-${isFinite(album.cover_mtime) ? album.cover_mtime : 0}`;
      if (!inflight.has(key)) inflight.set(key, build(album, variant).finally(() => inflight.delete(key)));
      return inflight.get(key);
    },
  };
}
