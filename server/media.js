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

/** Convierte las canciones pendientes, de a una y con prioridad baja (el servidor comparte CPU con Valheim). */
export function createTranscoder({ db, config, log }) {
  const audioDir = path.join(config.dataDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  let running = false;
  let again = false;
  let current = null;

  async function convert(t) {
    current = t.id;
    const src = await safeRealPath(config.musicDir, t.rel);
    if (!src) throw new Error('ruta de origen no permitida o archivo no encontrado');
    const name = `${t.id}-${t.mtime}.m4a`;
    const out = path.join(audioDir, name);
    const tmp = `${out}.tmp.m4a`;
    await run('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-i', src, '-vn', '-map_metadata', '-1',
      '-c:a', 'aac', '-b:a', config.aacBitrate, '-threads', '1', '-movflags', '+faststart', tmp], { lowPriority: true });
    await fsp.rename(tmp, out);
    const duration = await probeDuration(out);
    db.prepare("UPDATE tracks SET audio_status='ok', audio_file=?, duration=?, audio_error=NULL WHERE id=?").run(name, duration, t.id);
  }

  async function loop() {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        for (;;) {
          const t = db.prepare(`SELECT id, src_rel AS rel, src_mtime AS mtime FROM tracks
            WHERE audio_status='pending' AND missing=0 ORDER BY album_id, track_no, id LIMIT 1`).get();
          if (!t) break;
          try {
            await convert(t);
          } catch (err) {
            log?.warn?.({ track: t.id, err: err.message }, 'no se pudo convertir una canción');
            db.prepare("UPDATE tracks SET audio_status='error', audio_error=? WHERE id=?").run(String(err.message).slice(0, 400), t.id);
          }
        }
      } while (again);
    } finally {
      running = false;
      current = null;
    }
  }

  return {
    kick() { loop().catch((e) => log?.error?.(e)); },
    idle: () => !running,
    async whenIdle() { while (running) await new Promise((r) => setTimeout(r, 50)); },
    status() {
      const rows = db.prepare('SELECT audio_status AS s, COUNT(*) AS n FROM tracks WHERE missing=0 GROUP BY audio_status').all();
      const by = Object.fromEntries(rows.map((r) => [r.s, r.n]));
      return { ok: by.ok || 0, pending: by.pending || 0, error: by.error || 0, converting: current };
    },
    retryErrors() {
      return Number(db.prepare("UPDATE tracks SET audio_status='pending', audio_error=NULL WHERE audio_status='error'").run().changes);
    },
    /** Borra copias M4A que ya no sirven (canciones borradas o reemplazadas). */
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
