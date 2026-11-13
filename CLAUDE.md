# El Búnker Sound — contexto del proyecto

App web (PWA) para escuchar la música casera del dueño y compartirla con ~10 amigos. **Habla siempre en español simple** con el dueño (sus amigos no son técnicos). Interfaz y mensajes en español.

## Reglas del dueño (no negociables)
- **Solo servicios y herramientas gratuitas.**
- **Nunca pedir que peguen claves/tokens en el chat.** Los secretos van en `.env` en el servidor (lo escribe el dueño en su terminal).
- **No hay acceso al servidor** (Ubuntu `servermati`, usuario `tansis`, Docker, Tailscale, i7-7700, 11 GB RAM compartidos con servidores de Valheim → la app debe ser liviana). Se le dan comandos y él los corre. Despliegue = `./actualizar.sh`.
- **NO mezclar proyectos**: existen "El Bunker Servers" (Valheim, repo `bunker-servers`) y "El Bunker TV" (cámaras, repo `mirador-casa`). Este proyecto es independiente: no reutiliza sus cuentas ni su puerto. Las cámaras (puerto 443 de `servermati`) NUNCA se exponen.
- Probar todo lo posible (Chromium + Playwright, audio de prueba con ffmpeg) y **decir con honestidad qué se probó y qué no** (no hay iPhone ni la música real).
- No crear repos ni tocar configuración de GitHub: si falta algo, pedírselo. Repo: `malvarez2890-lang/El-Bunker-Sounds` (privado). Commits y push cuando haya cambios.

## REGLA DE ORO (del dueño, vale para esta app y para toda app futura): debe parecer una APP, no una web
- Pantalla de carga con el logo al abrir (HTML estático en `index.html`, se ve al instante) + imágenes de arranque de iPhone (`scripts/make-splash.py`).
- Sin zoom (`user-scalable=no`, `touch-action`, `gesturestart`), sin barras de navegador (`display: standalone`, `apple-mobile-web-app-capable`), sin selección de texto ni menú al mantener presionado.
- Pantalla **fija**: `html/body` en `position: fixed`, nada de scroll del documento ni rebote de la página entera; solo se desplazan las listas (`.page`). Barra superior e inferior quietas. Se ajusta al teclado con `visualViewport`.
- Navegación **por pilas** con transiciones suaves (`router.js`): pestañas deslizan lateralmente, detalle entra desde la derecha. **Arrastre con el dedo**: entre pestañas (izq./der.) y para volver (desde el borde izquierdo). Gestos ignorados mientras hay una animación o sobre carruseles (`.hscroll`) e inputs.
- Las pantallas se guardan vivas (no se recargan con "cargando…" al volver); se refrescan en silencio si hubo cambios (`bump()`).
- Probar siempre con Chromium móvil + toques reales por CDP (`test/e2e.test.js`), y decir qué NO se pudo probar en iPhone.

## Decisiones tomadas
- **Publicación (opción B):** contenedor con su **propio nodo Tailscale** (`musica.tailfd4430.ts.net`, puerto 443 propio, Funnel público). La app comparte red con el sidecar (`network_mode: service:tailscale`), no abre puertos en la LAN. `TRUST_PROXY=1` (un solo proxy).
- **Música:** WAV (Suno) en OneDrive del dueño → el servidor la baja con `rclone` (`scripts/sincronizar-musica.sh`). Estructura real: `Artista/<Artista>/{Albums,EPs,Singles}/<NN. Álbum>/<NN. Título>.wav + PORTADA.png + CONTRAPORTADA.png`. Hay artistas "PIÙ VELOCE" y "El MAS LENTO". Algunas canciones no tienen número (ej. "Mañana.wav"); algunos álbumes no tienen portada.
- **Audio:** los WAV originales quedan intactos (montados `:ro`). Se convierten **una vez** a **M4A AAC 256k** (iOS lo reproduce nativo, ~5x menos peso) con ffmpeg a baja prioridad (`nice`, 1 a la vez). Nunca se transcodifica en vivo. Copias y carátulas reducidas en el volumen `/data`.
- **Acceso:** sin contraseñas. Entrar con **Google** (OIDC + PKCE; opcional, solo aparece si hay `GOOGLE_CLIENT_ID/SECRET`) o **código de 6 dígitos por correo** (remitente `elbunkerservers@gmail.com` con una *contraseña de aplicación propia de esta app*). Usuarios nuevos quedan **pendientes** hasta que un admin los apruebe **desde la app (Administración)**. Admins = `ADMIN_EMAILS` (se activan solos). Favoritos/playlists/recientes son por usuario.
- **Diseño:** dossier en `design/dossier-ui-ux-v2.pdf` (v2, **solo móvil**, 4 pestañas: Inicio/Explorar/Biblioteca/Buscar + minirreproductor). Paleta: #090A0C, #141619, #202328, #363A40, #FFCB24 (oro), #F4A900, #F3F0E9, #A2A5AC. Tipografías Sora (títulos) + Inter, autoalojadas en `web/fonts`. En pantallas grandes se ve como columna de celular centrada. "Descargas/sin conexión" y "Géneros" NO están (WAV de Suno sin género; descargas "solo cuando exista soporte real").

## Arquitectura
- `server/` Node 22 + Fastify 5, **SQLite nativa (`node:sqlite`)**, sin dependencias nativas. Un solo proceso (~100 MB).
  - `scanner.js` recorre la carpeta (acepta con/sin la carpeta `Artista`, ignora enlaces simbólicos, normaliza Unicode NFC) → tablas artists/albums/tracks. Las rutas guardadas son relativas a `MUSIC_DIR`.
  - `media.js` convierte (cola de 1) y crea carátulas s/m/l/back en caché con ffmpeg.
  - `auth.js` sesiones (cookie `ebs_sid` httpOnly/secure/lax, 90 días, hash en BD), códigos por correo (máx. 5 intentos, 5 envíos/hora/correo), Google.
  - `routes/` auth, api (biblioteca, stream con Range, carátulas, favoritos, playlists, recientes), admin.
  - `safe-path.js` evita salir de la carpeta de música. El stream usa el nombre de archivo guardado en BD, nunca una ruta del usuario.
  - Seguridad: CSP estricta (sin inline), comprobación de `Origin`, rate limit global y estricto en login, nada de listado de archivos, música/carátulas solo con sesión **activa**.
- `web/` SPA en JS puro (módulos ES, **sin build**). Router por hash con pila de pantallas y gestos (`router.js`). `player.js` (cola, shuffle, repeat, Media Session, recuerda la cola; **cada canción se descarga COMPLETA a memoria como blob antes de sonar y se prepara la siguiente** — en iPhone el streaming por Range/Funnel fallaba: no saltaba de minuto, no retomaba ni pasaba a la siguiente; `unlock()` reproduce `web/silence.wav` en el primer toque porque iOS exige un gesto; `#/diagnostico` muestra estado/eventos del audio, accesible desde Administración), `playerui.js`, `ui.js` (componentes), `views/`. `sw.js` solo cachea la app (red primero); nunca API/música.
  - Ojo: usar `h()`/`add()`/`fill()` de `dom.js`, **no** `Element.append` con valores posiblemente null (escribe "null").
- Despliegue: `Dockerfile` (node:22-slim + ffmpeg), `docker-compose.yml` (tailscale + app), `deploy/tailscale-serve.json`, `.env.example`, `actualizar.sh`, `docs/SERVIDOR.md` (guía para el dueño).

## Comandos
- `npm test` → pruebas del servidor (`test/backend.test.js`, usa `app.inject`) y de navegador (`test/e2e.test.js`, Chromium móvil; deja capturas en `test-output/`, ignorado por git).
- Música de prueba: `python3 scripts/make-test-music.py <dir> [segundos]` (genera la misma estructura que la real, con casos raros: tildes, `&`, `'`, "3.17", sin número, sin portada, carpetas vacías).
- Dev: `MUSIC_DIR=<dir> DATA_DIR=./data ADMIN_EMAILS=tu@correo MAIL_MODE=file npm run dev` (en modo `file` los correos se guardan en `data/outbox/*.json`; ahí está el código).
- Iconos/logo: `python3 scripts/make-icons.py` (parte de `design/`).

## Estado y honestidad sobre pruebas
- **Probado aquí:** escáner, conversión real a M4A, rangos HTTP, seguridad de rutas, accesos/aprobación/bloqueo, límites de intentos, flujo Google contra un servidor de Google *simulado*, UI completa en Chromium móvil (audio avanza, Media Session con título/artista/álbum/carátulas, botones siguiente/pausa, favoritos, playlists, admin), `docker compose config`.
- **NO probado:** iPhone/Safari real (audio con pantalla bloqueada, carátula en pantalla de bloqueo, instalación PWA, login Google dentro de la PWA), Google real, SMTP real de Gmail, imagen Docker (no había daemon), Tailscale/Funnel real, la música real del dueño ni los límites de ancho de banda de Funnel.

## Problemas conocidos (iPhone)
- Reportado por el dueño (v. streaming): no pasaba a la siguiente canción, la barra no saltaba y al reabrir empezaba de cero. Causa más probable: iOS no podía saltar/seguir en el audio por streaming. Arreglo: reproducción desde memoria (blob) + guardar posición en `pagehide`/`visibilitychange` + retomar al apretar play. **Sin verificar en iPhone**; si persiste, pedir captura de `#/diagnostico` (Administración → Herramientas → "Diagnóstico del audio"; ya no está en el menú del perfil).
- Si el dueño CIERRA la app (la desliza hacia arriba) iOS la mata y la música se detiene: normal. Al volver, retoma desde la posición guardada.
- Al tocar la tarjeta de la pantalla de bloqueo, iOS abrió OTRA web app del dueño en vez de El Búnker Sound. Se agregó `id` y `start_url` propios (`/?app=el-bunker-sound`) al manifest; hay que **quitar y volver a instalar** la app para que iOS lo tome. Si persiste, investigar (¿otra PWA del mismo dominio `*.ts.net`? ¿instalada desde Safari o desde otra?).

- Confirmado con capturas del dueño: en la pantalla de bloqueo se ven carátula, título, artista, barra y botones. Tocar la tarjeta abre **otra** web app ("Numa", de otro dominio) = error conocido de iOS 26 (Apple FB25262874, sin solución web; ver foro de Apple 852546). NO es del código ni del dominio. **Confirmado por el dueño:** al quitar el ícono de Numa (PWA en workers.dev) la tarjeta ya abre El Búnker Sound. Mientras haya otra web app instalada puede abrirse la equivocada; no es del código. Si un amigo tiene otras PWAs instaladas puede pasarle lo mismo (aviso en la guía de uso).
- iOS muestra "±10 s" en la tarjeta si se registran `seekbackward/seekforward`; por eso NO se registran (así aparecen anterior/siguiente).

- Pantalla bloqueada: la canción sonaba pero NO pasaba a la siguiente hasta desbloquear (iOS congela la app justo cuando el audio termina, y el evento `ended` llegaba tarde). Arreglo: **dos reproductores (A/B)** en `player.js`; el libre tiene cargada la siguiente y arranca ~0,5 s antes del final (`maybeHandoff`, solo cambia de rol si `play()` tuvo éxito; si falla queda el camino normal por `ended`). Probado en Chromium suprimiendo `ended` (test e2e). **Sin verificar en iPhone**; si falla, mirar `#/diagnostico` (líneas `traspaso` / `traspaso rechazado`).

## Pendiente / ideas para después
- Probar en iPhone real y ajustar (sesión PWA vs Safari, Media Session, `ended`→siguiente en segundo plano).
- Endurecer la política de Tailscale (que `tag:musica` no alcance otros equipos) — hacerlo junto al dueño, sin tocar su política a ciegas.
- Opcionales: letras, ecualizador, estadísticas, listas compartidas entre amigos, subir música desde la app, reordenar la cola/playlists, géneros si algún día hay etiquetas.
