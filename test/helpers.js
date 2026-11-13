import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import { buildApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Música de prueba compartida entre pruebas (se crea una sola vez). */
export function testMusicDir(secs = '2') {
  const dir = path.join(os.tmpdir(), `ebs-test-music-${secs}s`);
  if (!fs.existsSync(path.join(dir, 'Artista'))) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('python3', [path.join(here, '..', 'scripts', 'make-test-music.py'), dir, secs], { stdio: 'inherit' });
  }
  return dir;
}

export async function makeApp(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebs-data-'));
  const config = loadConfig({
    MUSIC_DIR: extra.MUSIC_DIR || testMusicDir(), DATA_DIR: dataDir, BASE_URL: 'http://localhost:3999',
    ADMIN_EMAILS: 'admin@test.cl', MAIL_MODE: 'file', SCAN_INTERVAL_MIN: '0', ...extra,
  });
  const { app, ctx } = await buildApp(config, { logger: false });
  await ctx.library.scan();
  await ctx.transcoder.whenIdle();

  const lastCode = (email) => {
    const dir = path.join(dataDir, 'outbox');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    for (const f of files.reverse()) {
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (m.to === email) return /es (\d{6})\./.exec(m.text)?.[1];
    }
  };
  /** Inicia sesión por código de correo y devuelve el encabezado Cookie. */
  let ipCounter = 10;
  async function login(email) {
    const remoteAddress = `10.1.${ipCounter >> 8}.${ipCounter++ & 255}`; // una IP distinta por inicio, para no chocar con el límite de intentos
    await app.inject({ method: 'POST', url: '/api/auth/email/start', payload: { email }, remoteAddress });
    const res = await app.inject({ method: 'POST', url: '/api/auth/email/verify', payload: { email, code: lastCode(email) }, remoteAddress });
    const sid = res.cookies.find((c) => c.name === 'ebs_sid')?.value;
    return { cookie: `ebs_sid=${sid}`, res };
  }
  const api = (cookie) => (method, url, payload, headers = {}) =>
    app.inject({ method, url, payload, headers: { cookie, ...headers } });
  return { app, ctx, config, dataDir, login, api, lastCode, close: () => app.close() };
}
