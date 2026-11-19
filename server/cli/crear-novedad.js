// Crea una novedad desde la terminal del servidor (sin abrir la app):
//   docker compose exec app node server/cli/crear-novedad.js la-vita-singles
// También acepta:  --proximamente (tarjeta destacada "¡PRÓXIMAMENTE!")  --titulo "…" --texto "…" --album "nombre del álbum"
import { loadConfig } from '../config.js';
import { openDb } from '../db.js';
import { createLibraryQueries } from '../library.js';
import { createNews } from '../news.js';
import { norm } from '../util.js';

export const PRESETS = {
  'la-vita-singles': {
    titulo: 'Primeros 4 singles de La Vita È Un Gioco',
    texto: 'PIÙ VELOCE adelanta 4 canciones de su nuevo álbum: Tutto Sotto Controllo, Telefono Occupato, Noi Siamo y Birra Elegante. Italo disco para encender la noche. El álbum completo llega el 21 de noviembre.',
    album: 'la vita e un gioco',
  },
  'fran-proximamente': {
    titulo: 'FRAN, el nuevo álbum de Francesca Luce',
    texto: 'Francesca Luce (PIÙ VELOCE) prepara su nuevo álbum: 15 canciones para viajar de noche por la costa. Muy pronto.',
    album: 'fran',
    proximamente: true,
  },
};

export function crearNovedad({ db, argv }) {
  const lib = createLibraryQueries(db);
  const news = createNews({ db, lib });
  const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const preset = PRESETS[argv.find((a) => !a.startsWith('--') && PRESETS[a])] || {};
  const titulo = opt('titulo') ?? preset.titulo;
  const texto = opt('texto') ?? preset.texto ?? '';
  const albumQ = opt('album') ?? preset.album;
  if (!titulo) return { ok: false, msg: `Falta el título. Usa un nombre de plantilla (${Object.keys(PRESETS).join(', ')}) o --titulo "…".` };

  let albumId = null;
  if (albumQ) {
    const found = lib.albumsAny('AND al.search LIKE ?', [`%${norm(albumQ)}%`])[0];
    if (!found) return { ok: false, msg: `No encuentro el álbum “${albumQ}”. Primero copia la música y toca “Buscar música nueva” en Administración; después vuelve a correr este comando.` };
    albumId = found.id;
  }
  const dup = news.list({ all: true }).find((n) => n.title === titulo);
  if (dup) return { ok: true, msg: `Ya existía la novedad “${titulo}”. No hice nada.`, item: dup };
  const item = news.create({ title: titulo, body: texto, albumId, active: true, soon: argv.includes('--proximamente') || !!preset.proximamente });
  return { ok: true, msg: `Listo: novedad “${item.title}” creada${item.album ? ` (${item.album.hidden ? 'solo se ve la portada' : `abre el álbum “${item.album.title}”`})` : ''}. Ya se ve arriba en Inicio.`, item };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const db = openDb(config.dataDir, config.tz);
  const r = crearNovedad({ db, argv: process.argv.slice(2) });
  console.log(r.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`);
  process.exit(r.ok ? 0 : 1);
}
