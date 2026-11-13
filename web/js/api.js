export class ApiError extends Error {
  constructor(status, code) { super(code || `HTTP ${status}`); this.status = status; this.code = code; }
}

const listeners = new Set();
export const onUnauthorized = (fn) => listeners.add(fn);

export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'sin_conexion');
  }
  let data = null;
  try { data = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/') && url !== '/api/me') listeners.forEach((fn) => fn());
    throw new ApiError(res.status, data?.error);
  }
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
  if (err?.code === 'sin_conexion') return 'No hay conexión con el servidor.';
  if (err?.status === 429) return 'Demasiados intentos. Espera unos minutos.';
  if (err?.status >= 500) return 'El servidor tuvo un problema. Intenta de nuevo.';
  return 'Algo salió mal. Intenta de nuevo.';
}
