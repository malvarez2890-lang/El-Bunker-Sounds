// Revisa qué entiende la app de cada TRACKLIST.txt y qué hará con cada canción. Solo LEE: no cambia nada.
//   docker compose exec app node server/cli/revisar-tracklist.js
import { loadConfig } from '../config.js';
import { readLibraryFromDisk } from '../scanner.js';
import { todayIn } from '../db.js';

export async function revisar(config) {
  const hoy = todayIn(config.tz);
  const out = [`Carpeta de música: ${config.musicDir}`, `Hoy (${config.tz}): ${hoy}`, ''];
  const { artists } = await readLibraryFromDisk(config.musicDir);
  let conLista = 0;
  for (const a of artists) {
    for (const r of a.releases) {
      if (!r.tracklist) continue;
      conLista++;
      const tl = r.tracklist;
      out.push(`Álbum: ${a.name} · ${r.title}`);
      if (tl.unreadable) { out.push('  ❌ Encontré TRACKLIST.txt pero no pude leerlo (¿pesa más de 64 KB o está dañado?).', ''); continue; }
      out.push(`  ✅ TRACKLIST.txt leído: ${tl.entries} canciones numeradas.`);
      out.push(tl.releaseDate ? `  ✅ Lanzamiento: ${tl.releaseDate}${tl.releaseDate > hoy ? '' : '  (esa fecha YA llegó: todo suena)'}` : '  ❌ No encontré una línea “Lanzamiento: 21 de noviembre de 2026” (sin ella no se programa nada).');
      out.push(tl.available.length ? `  ✅ Disponibles desde ya: ${tl.available.join(', ')}` : '  ❌ No encontré una línea “Disponibles: 3, 4, 5, 8” (sin ella no se programa nada).');
      out.push('  Lo que hará la app con cada canción:');
      for (const t of r.tracks) {
        const n = String(t.trackNo ?? '?').padStart(2, '0');
        const estado = t.upcoming ? 'en gris: todavía no tiene archivo'
          : t.releaseDate && t.releaseDate > hoy ? `🔒 en gris hasta el ${t.releaseDate} (tiene archivo, ya convertida cuando termine)`
            : '🔊 suena ahora';
        out.push(`    ${n}. ${t.title} → ${estado}`);
      }
      out.push('');
    }
  }
  if (!conLista) out.push('No encontré ningún TRACKLIST.txt dentro de la carpeta de música. ¿Está dentro de la carpeta del álbum y se llama exactamente TRACKLIST.txt (no “TRACKLIST.txt.txt”)?');
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(await revisar(loadConfig()));
}
