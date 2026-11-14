// Versión de la app: si el servidor se actualizó, la app abierta se recarga sola (cuando no suena nada en el teléfono).
import { get } from './api.js';
import * as player from './player.js';

let current = null;
export const appVersion = () => current;
export async function initVersion() {
  try { current = (await get('/api/version')).v; } catch { /* sin conexión */ }
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
