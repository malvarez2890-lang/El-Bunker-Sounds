// Manda un correo a todos los que tienen acceso (cuenta activa) avisando que salió un álbum.
// Por seguridad, SIN "--enviar" solo muestra a quién se mandaría y no envía nada:
//   docker compose exec app node server/cli/avisar-por-correo.js la-vita
//   docker compose exec app node server/cli/avisar-por-correo.js la-vita --enviar
import { loadConfig } from '../config.js';
import { openDb } from '../db.js';
import { createLibraryQueries } from '../library.js';
import { createMailer, albumReleasedMail } from '../mail.js';
import { createCovers } from '../media.js';
import { norm } from '../util.js';

export const AVISOS = {
  'la-vita': {
    album: 'la vita e un gioco',
    texto: 'ya salió el álbum completo de PIÙ VELOCE, "La Vita È Un Gioco": 13 canciones para escuchar de principio a fin.',
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Devuelve { ok, msg, to: [...] }. Con enviar=false no manda nada. */
export async function avisarPorCorreo({ db, config, mailer, aviso, enviar = false, pausaMs = 1500, log = () => {} }) {
  const preset = AVISOS[aviso];
  if (!preset) return { ok: false, msg: `Aviso desconocido. Usa uno de: ${Object.keys(AVISOS).join(', ')}.`, to: [] };
  const lib = createLibraryQueries(db);
  const album = lib.albums('AND al.search LIKE ?', [`%${norm(preset.album)}%`])[0];
  if (!album) return { ok: false, msg: 'No encuentro ese álbum con canciones disponibles. Primero sincroniza la música y toca “Buscar música nueva”.', to: [] };
  let coverPath = null;
  try { const row = lib.albumForCover(album.id); coverPath = row ? await createCovers({ config }).get(row, 'm') : null; } catch { /* sin portada */ }
  const users = db.prepare("SELECT name, email FROM users WHERE status = 'active' ORDER BY id").all();
  if (!users.length) return { ok: false, msg: 'No hay usuarios con acceso.', to: [] };
  if (!enviar) return { ok: true, enviado: false, msg: `Se enviaría a ${users.length} persona(s). NO se envió nada. Para enviar, agrega --enviar.`, to: users.map((u) => u.email) };
  const to = []; const fallos = [];
  for (const u of users) {
    try {
      await mailer.send({ to: u.email, ...albumReleasedMail({ name: String(u.name || '').split(' ')[0] || 'amigo', albumTitle: album.title, artistName: album.artistName, text: preset.texto, baseUrl: config.baseUrl, coverPath }) });
      to.push(u.email); log(`✓ ${u.email}`);
    } catch (err) { fallos.push(u.email); log(`✗ ${u.email}: ${err.message}`); }
    await sleep(pausaMs); // sin apuro, para que Gmail no lo tome como spam
  }
  return { ok: fallos.length === 0, enviado: true, msg: `Enviado a ${to.length} de ${users.length}.${fallos.length ? ` Fallaron: ${fallos.join(', ')}.` : ''}`, to, fallos };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const db = openDb(config.dataDir, config.tz);
  const argv = process.argv.slice(2);
  const r = await avisarPorCorreo({ db, config, mailer: createMailer({ config, log: null }), aviso: argv.find((a) => !a.startsWith('--')), enviar: argv.includes('--enviar'), log: console.log });
  if (r.to.length && !r.enviado) console.log(r.to.map((e) => `  - ${e}`).join('\n'));
  console.log(r.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`);
  process.exit(r.ok ? 0 : 1);
}
