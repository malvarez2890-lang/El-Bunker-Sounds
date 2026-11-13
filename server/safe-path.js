// Evita que una ruta salga de la carpeta permitida (../, enlaces simbólicos, etc.).
import path from 'node:path';
import fs from 'node:fs';

/** Une base + relativa. Devuelve null si el resultado queda fuera de base. */
export function safeJoin(base, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  const root = path.resolve(base);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/** Igual que safeJoin, pero además comprueba la ruta real (enlaces simbólicos). */
export async function safeRealPath(base, rel) {
  const full = safeJoin(base, rel);
  if (!full) return null;
  try {
    const [realBase, realFull] = await Promise.all([fs.promises.realpath(base), fs.promises.realpath(full)]);
    if (realFull !== realBase && !realFull.startsWith(realBase + path.sep)) return null;
    return realFull;
  } catch {
    return null;
  }
}
