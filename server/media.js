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

/**
 * Copias MP3 (320k) solo para el Onkyo, creadas una vez desde el WAV original. De a una y con prioridad baja.
 * Lo que se pide para sonar YA (ensure) pasa adelante; el resto se prepara en segundo plano cuando la conversión a M4A terminó.
 */
export function createMp3Cache({ db, config, log, transcoder }) {
  const dir = path.join(config.dataDir, 'onkyo-mp3');
  fs.mkdirSync(dir, { recursive: true });
  const jobs = new Map();   // id -> { promise, resolve, reject, started }
  const queue = [];         // ids por convertir (los urgentes se agregan al principio)
  let working = false;
  const failed = new Set(); // canciones que ya fallaron: el segundo plano no las reintenta en bucle

  const row = (id) => db.prepare('SELECT id, src_rel AS rel, src_mtime AS mtime FROM tracks WHERE id=? AND missing=0').get(id);
  const fileOf = (t) => path.join(dir, `${t.id}-${t.mtime}.mp3`);
  const exists = (f) => { try { return fs.statSync(f).size > 0; } catch { return false; } };

  async function work() {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const id = queue.shift();
        const job = jobs.get(id);
        const t = row(id);
        try {
          if (!t) throw new Error('canción no encontrada');
          const out = fileOf(t);
          if (!exists(out)) {
            const src = await safeRealPath(config.musicDir, t.rel);
            if (!src) throw new Error('ruta de origen no permitida o archivo no encontrado');
            const tmp = `${out}.tmp.mp3`;
            await run('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-i', src, '-vn', '-map_metadata', '-1', '-ac', '2', '-ar', '44100',
              '-c:a', 'libmp3lame', '-b:a', '320k', '-threads', '1', '-f', 'mp3', tmp], { lowPriority: true });
            await fsp.rename(tmp, out);
          }
          job?.resolve(out);
        } catch (err) {
          log?.warn?.({ track: id, err: err.message }, 'no se pudo crear el MP3 para el Onkyo');
          failed.add(id);
          job?.reject(err);
        } finally { jobs.delete(id); }
      }
    } finally { working = false; }
  }

  function enqueue(id, urgent) {
    let job = jobs.get(id);
    if (!job) {
      job = {};
      job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      job.promise.catch(() => {}); // si nadie lo espera (segundo plano), que no moleste
      jobs.set(id, job);
      urgent ? queue.unshift(id) : queue.push(id);
    } else if (urgent) { const i = queue.indexOf(id); if (i > 0) { queue.splice(i, 1); queue.unshift(id); } }
    work();
    return job.promise;
  }

  let bg = null;
  return {
    dir,
    /** Ruta del MP3 si ya existe (para servirlo); si no, null. */
    pathIfReady(id) { const t = row(id); return t && exists(fileOf(t)) ? fileOf(t) : null; },
    /** Devuelve la ruta del MP3, creándolo ya si falta. */
    async ensure(id) { const t = row(id); if (!t) throw new Error('canción no encontrada'); const f = fileOf(t); if (exists(f)) return f; failed.delete(id); return enqueue(id, true); }, // pedida a mano: se intenta de nuevo
    /** Deja lista una canción sin esperar (la siguiente de la cola). */
    prefetch(id) { const t = row(id); if (t && !exists(fileOf(t))) enqueue(id, true).catch(() => {}); },
    /** Prepara toda la biblioteca poco a poco, solo cuando el servidor no está convirtiendo M4A. */
    prepareAll() {
      if (bg) return;
      bg = (async () => {
        try {
          for (;;) {
            if (transcoder && !transcoder.idle()) { await new Promise((r) => setTimeout(r, 5000)); continue; }
            const ids = db.prepare("SELECT id FROM tracks WHERE missing=0 AND audio_status='ok' ORDER BY album_id, track_no, id").all().map((r) => r.id);
            const next = ids.find((id) => { const t = row(id); return t && !failed.has(id) && !exists(fileOf(t)) && !jobs.has(id); });
            if (next == null) break;
            await enqueue(next, false).catch(() => {});
          }
        } finally { bg = null; }
      })();
    },
    status() {
      const ids = db.prepare("SELECT id FROM tracks WHERE missing=0 AND audio_status='ok'").all();
      return { total: ids.length, ready: ids.filter((r) => { const t = row(r.id); return t && exists(fileOf(t)); }).length };
    },
    async cleanup() {
      const keep = new Set(db.prepare('SELECT id, src_mtime AS m FROM tracks WHERE missing=0').all().map((r) => `${r.id}-${r.m}.mp3`));
      for (const f of await fsp.readdir(dir)) {
        const full = path.join(dir, f);
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
