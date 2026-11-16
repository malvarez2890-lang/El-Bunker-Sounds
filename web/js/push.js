// Avisos al celular (notificaciones). Funciona en iPhone (iOS 16.4+) con la app instalada en la pantalla de inicio, y en Android.
import { get, post } from './api.js';

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () => navigator.standalone || matchMedia('(display-mode: standalone)').matches;
const keyBytes = (s) => {
  const raw = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/** 'on' | 'off' | 'denied' | 'needs-install' | 'unsupported' */
export async function pushState() {
  const capable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!capable) return isIOS() && !isStandalone() ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    return sub && Notification.permission === 'granted' ? 'on' : 'off';
  } catch { return 'off'; }
}

/** Pide permiso (debe llamarse desde un toque) y registra este celular en el servidor. */
export async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await get('/api/push/config');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const j = sub.toJSON();
  await post('/api/push/subscribe', { endpoint: j.endpoint, keys: j.keys });
  return 'on';
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) { const endpoint = sub.endpoint; await sub.unsubscribe().catch(() => {}); await post('/api/push/unsubscribe', { endpoint }).catch(() => {}); }
}

/** Al abrir la app: si ya había avisos activados, se le recuerda al servidor (por si el celular cambió su dirección). */
export async function syncPush() {
  try {
    if (await pushState() !== 'on') return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg.pushManager.getSubscription();
    const j = sub.toJSON();
    await post('/api/push/subscribe', { endpoint: j.endpoint, keys: j.keys });
  } catch { /* sin conexión: otra vez será */ }
}

export const PUSH_HELP = {
  'needs-install': 'Para recibir avisos, instala la app: toca Compartir en Safari y elige “Agregar a pantalla de inicio”. Luego ábrela desde el ícono.',
  denied: 'Los avisos están bloqueados. Actívalos en Ajustes del teléfono → Notificaciones → El Búnker Sound.',
  unsupported: 'Este teléfono o navegador no permite avisos.',
};
