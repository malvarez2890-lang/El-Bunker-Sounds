// Versión de la app: si el servidor se actualizó, la app abierta se recarga sola (cuando no suena nada en el teléfono).
import { get } from './api.js';
import * as player from './player.js';

let current = null;
let label = '';
export const appVersion = () => label || current; // lo que ve la persona: fecha y hora de la actualización
export async function initVersion() {
  try { const r = await get('/api/version'); current = r.v; label = r.label || ''; } catch { /* sin conexión */ }
}
let checking = false;
export async function checkForUpdate() {
  if (checking || !current) return;
  checking = true;
  try {
    const { v } = await get('/api/version');
    // Si suena música en el teléfono no se corta: se aplica en la próxima vez. Con el Onkyo se puede recargar (se recupera sola).
    if (v && v !== current && (player.isRemote() || !player.isPlayingUI())) location.reload();
  } catch { /* sin conexión */ } finally { checking = false; }
}
