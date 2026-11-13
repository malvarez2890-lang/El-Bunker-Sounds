// Configuración leída desde variables de entorno (archivo .env en el servidor).
import path from 'node:path';

const truthy = (v, def = false) =>
  v == null || v === '' ? def : /^(1|true|yes|si|sí|on)$/i.test(String(v));

export function loadConfig(overrides = {}) {
  const e = { ...process.env, ...overrides };
  const port = Number(e.PORT || 3000);
  const baseUrl = (e.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  return {
    port,
    host: e.HOST || '0.0.0.0',
    baseUrl,
    secureCookies: baseUrl.startsWith('https://'),
    // Número = cuántos proxies confiar (1 = solo el de Tailscale; así nadie puede falsear su IP para saltarse los límites).
    trustProxy: /^\d+$/.test(String(e.TRUST_PROXY ?? '')) ? Number(e.TRUST_PROXY) : truthy(e.TRUST_PROXY, false),
    musicDir: path.resolve(e.MUSIC_DIR || './music'),
    dataDir: path.resolve(e.DATA_DIR || './data'),
    adminEmails: (e.ADMIN_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    sessionDays: Number(e.SESSION_DAYS || 90),
    aacBitrate: e.AAC_BITRATE || '256k',
    scanIntervalMin: Number(e.SCAN_INTERVAL_MIN ?? 15),
    mail: {
      mode: e.MAIL_MODE || (e.SMTP_USER ? 'smtp' : 'file'), // 'smtp' | 'file'
      host: e.SMTP_HOST || 'smtp.gmail.com',
      port: Number(e.SMTP_PORT || 465),
      user: e.SMTP_USER || '',
      pass: e.SMTP_PASS || '',
      from: e.MAIL_FROM || (e.SMTP_USER ? `El Búnker Sound <${e.SMTP_USER}>` : 'El Búnker Sound <no-responder@localhost>'),
    },
    google: {
      clientId: e.GOOGLE_CLIENT_ID || '',
      clientSecret: e.GOOGLE_CLIENT_SECRET || '',
      authUrl: e.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: e.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    },
    logLevel: e.LOG_LEVEL || 'info',
  };
}
