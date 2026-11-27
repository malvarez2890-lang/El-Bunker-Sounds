export class ApiError extends Error {
  constructor(status, code, detail) { super(code || `HTTP ${status}`); this.status = status; this.code = code; this.detail = detail; }
}

const listeners = new Set();
export const onUnauthorized = (fn) => listeners.add(fn);
const mutationListeners = new Set();
/** Avisa cuando algo se modifica (favorito, playlist, reproducción…), para refrescar pantallas guardadas. */
export const onMutation = (fn) => mutationListeners.add(fn);

// ¿El servidor responde? Lo anuncia la app entera (aviso arriba) y se recupera solo al volver.
let serverDown = false;
export const isServerDown = () => serverDown;
export const isDownStatus = (s) => s === 0 || s === 502 || s === 503 || s === 504 || s === 522 || s === 523 || s === 524;
function setDown(v) { if (v !== serverDown) { serverDown = v; window.dispatchEvent(new CustomEvent('ebs:net', { detail: { down: v } })); } }

export async function api(method, url, body) {
  let res;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000); // si el servidor no contesta en 20 s, se considera caído
  try {
    res = await fetch(url, {
      method, credentials: 'same-origin', signal: ctrl.signal,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    setDown(true);
    throw new ApiError(0, 'sin_conexion');
  } finally { clearTimeout(timer); }
  if (isDownStatus(res.status)) { setDown(true); throw new ApiError(res.status, 'servidor_caido'); } // la puerta responde pero la app no
  setDown(false);
  let data = null;
  try { data = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/') && url !== '/api/me') listeners.forEach((fn) => fn());
    throw new ApiError(res.status, data?.error, data?.detail);
  }
  if (method !== 'GET') mutationListeners.forEach((fn) => fn());
  return data;
}
export const get = (url) => api('GET', url);
export const post = (url, body = {}) => api('POST', url, body);
export const put = (url) => api('PUT', url, undefined);
export const patch = (url, body) => api('PATCH', url, body);
export const del = (url) => api('DELETE', url, undefined);

export const coverUrl = (albumId, variant = 'm', v = 0) => `/api/cover/${albumId}/${variant}?v=${v || 0}`;
export const streamUrl = (trackId) => `/api/stream/${trackId}`;

export function errorText(err) {
  if (err?.code === 'sin_conexion' || err?.code === 'servidor_caido') return 'No hay conexión con el servidor.';
  if (err?.status === 429) return 'Demasiados intentos. Espera unos minutos.';
  if (err?.status >= 500) return 'El servidor tuvo un problema. Intenta de nuevo.';
  return 'Algo salió mal. Intenta de nuevo.';
}
