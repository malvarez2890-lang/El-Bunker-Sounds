// Lanzamientos: cuando un álbum queda COMPLETO (todas sus canciones listas y ya liberadas), se avisa una sola vez
// por correo a todos los que tienen acceso y por notificación al celular. Funciona solo, también el día de un lanzamiento programado.
import { albumReleasedMail } from './mail.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// "lista" = ya convertida y no programada para otra fecha
const READY = "t.audio_status = 'ok' AND NOT (t.release_date IS NOT NULL AND t.release_date > ebs_today())";
const COMPLETE = `EXISTS(SELECT 1 FROM tracks t WHERE t.album_id = al.id AND t.missing = 0 AND ${READY})
  AND NOT EXISTS(SELECT 1 FROM tracks t WHERE t.album_id = al.id AND t.missing = 0 AND NOT (${READY}))`;

export function createLaunch({ db, config, push, mailer, log, covers, lib }) {
  const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
  const setSetting = (k, v) => db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
  const hourNow = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: config.tz, hour: '2-digit', hour12: false }).format(new Date())) % 24;
  let running = false;

  return {
    enabled: () => getSetting('auto_launch') !== '0', // por defecto, encendido
    setEnabled: (on) => setSetting('auto_launch', on ? '1' : '0'),

    /** Revisa si hay álbumes recién completos y avisa (una sola vez cada uno). Devuelve los títulos avisados. */
    async check() {
      if (running) return [];
      running = true;
      try {
        // La primera vez, lo que ya está completo se da por lanzado: solo se avisa lo que llegue o se complete desde ahora.
        if (getSetting('launch_baseline') !== '1') {
          db.prepare(`UPDATE albums AS al SET launched = 1 WHERE al.missing = 0 AND ${COMPLETE}`).run();
          setSetting('launch_baseline', '1');
        }
        if (!this.enabled()) return [];
        const [from, to] = config.launch.hours;
        const h = hourNow();
        if (h < from || h >= to) return []; // nada de avisos de madrugada: se espera a la mañana
        const rows = db.prepare(`SELECT al.id, al.title, ar.name AS artist,
            (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id AND t.missing = 0) AS n
          FROM albums al JOIN artists ar ON ar.id = al.artist_id
          WHERE al.missing = 0 AND ar.missing = 0 AND al.launched = 0 AND ${COMPLETE}`).all();
        const done = [];
        for (const a of rows) {
          // se marca ANTES de avisar: si algo falla a medias, no se manda dos veces
          db.prepare('UPDATE albums SET launched = 1 WHERE id = ?').run(a.id);
          db.prepare('UPDATE tracks SET announced = 1 WHERE album_id = ?').run(a.id); // el aviso de "música nueva" suelta no lo repite
          const cuantas = a.n === 1 ? '1 canción' : `${a.n} canciones`;
          try { await push.notifyAll({ title: `¡Ya salió ${a.title}!`, body: `${a.artist} · ${cuantas}`, url: `/#/album/${a.id}`, tag: `launch-${a.id}` }); }
          catch (err) { log?.warn?.({ err: err.message, album: a.id }, 'lanzamiento: falló el aviso al celular'); }
          let coverPath = null;
          try { const row = lib?.albumForCover(a.id); coverPath = row && covers ? await covers.get(row, 'm') : null; } catch { /* sin portada */ }
          const users = db.prepare("SELECT name, email FROM users WHERE status = 'active' ORDER BY id").all();
          let ok = 0;
          for (const u of users) {
            try {
              await mailer.send({ to: u.email, ...albumReleasedMail({ name: String(u.name || '').split(' ')[0] || 'amigo', albumTitle: a.title, artistName: a.artist, text: `ya salió "${a.title}": ${cuantas} para escuchar.`, baseUrl: config.baseUrl, coverPath }) });
              ok++;
            } catch (err) { log?.warn?.({ err: err.message, to: u.email }, 'lanzamiento: falló un correo'); }
            if (config.launch.pauseMs) await sleep(config.launch.pauseMs);
          }
          log?.info?.({ album: a.title, correos: ok, de: users.length }, 'lanzamiento avisado');
          done.push(a.title);
        }
        return done;
      } finally { running = false; }
    },
  };
}
