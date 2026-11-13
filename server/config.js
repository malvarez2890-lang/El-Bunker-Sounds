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
    // Receptor Onkyo (opcional). Se activa solo si están ONKYO_IP y ONKYO_LAN_IP.
    onkyo: {
      ip: e.ONKYO_IP || '',
      lanIp: e.ONKYO_LAN_IP || '',                 // IP de ESTE servidor en la red de la casa (la que el Onkyo puede alcanzar)
      lanPort: Number(e.ONKYO_LAN_PORT || 8099),
      lanHost: e.ONKYO_LAN_HOST || '0.0.0.0',
      eiscpPort: Number(e.ONKYO_EISCP_PORT || 60128),
      upnpPort: Number(e.ONKYO_UPNP_PORT || 8888),
      descPath: e.ONKYO_DESC_PATH || '/upnp_descriptor_0',
      format: ['m4a', 'wav', 'mp3'].includes(String(e.ONKYO_FORMAT || '').toLowerCase()) ? String(e.ONKYO_FORMAT).toLowerCase() : 'mp3',
      maxVolume: Math.min(80, Math.max(1, Number(e.ONKYO_MAX_VOLUME || 50))), // tope de seguridad (el TX-8130 llega a 80)
      secret: e.ONKYO_SECRET || '',
      linkTtlSec: Number(e.ONKYO_LINK_TTL || 1800),
      fastMs: Number(e.ONKYO_FAST_MS || 8000),       // cuánto espera la app antes de responder "cargando" (la conversión sigue en segundo plano)
      endSlackSec: Number(e.ONKYO_END_SLACK || 6),   // si se detiene a menos de estos segundos del final, se considera que terminó
      pollMs: Number(e.ONKYO_POLL_MS || 2000),
      retryMs: Number(e.ONKYO_RETRY_MS || 1500),
      bootWaitMs: Number(e.ONKYO_BOOT_WAIT_MS || 1500),
      inputWaitMs: Number(e.ONKYO_INPUT_WAIT_MS || 2500),
    },
    logLevel: e.LOG_LEVEL || 'info',
  };
}
