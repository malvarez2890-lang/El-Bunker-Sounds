# Instalar El Búnker Sound en tu servidor

Todo esto se hace **una sola vez**. Después, para actualizar, solo corres `./actualizar.sh`.
Los comandos se escriben en tu servidor (por ejemplo con Termius). Los secretos (claves) **nunca** se pegan en el chat: van en el archivo `.env` del servidor.

---

## 1. Bajar el proyecto desde GitHub

El repositorio es privado, así que el servidor necesita su propia llave (solo lectura). Usamos una llave **separada** de la de tus otros proyectos.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/bunker_sound_deploy -N "" -C "servermati bunker-sound"
cat ~/.ssh/bunker_sound_deploy.pub
```

1. Copia el texto que sale (empieza con `ssh-ed25519`).
2. En GitHub: repositorio **El-Bunker-Sounds → Settings → Deploy keys → Add deploy key**. Ponle un nombre, pega el texto y **no** marques "Allow write access".
3. De vuelta en el servidor:

```bash
cat >> ~/.ssh/config <<'CFG'

Host github-bunker-sound
  HostName github.com
  User git
  IdentityFile ~/.ssh/bunker_sound_deploy
  IdentitiesOnly yes
CFG
git clone git@github-bunker-sound:malvarez2890-lang/El-Bunker-Sounds.git ~/el-bunker-sounds
cd ~/el-bunker-sounds
```

## 2. Tailscale: darle a la app su propio nombre y su propia puerta

La app usa **su propio nodo de Tailscale** (un contenedor aparte). Así tiene su propio nombre y su propio puerto 443, y **no toca** Valheim ni las cámaras.

En https://login.tailscale.com/admin/acls (Access controls) agrega estas dos cosas **sin borrar lo que ya tienes**:

```json
"tagOwners": { "tag:musica": ["autogroup:admin"] },
```
y dentro de `"nodeAttrs"` (si no existe, créalo):
```json
"nodeAttrs": [
  { "target": ["tag:musica"], "attr": ["funnel"] }
]
```
> Si tu política ya tiene `tagOwners` o `nodeAttrs`, agrega la línea dentro de los que existen. Si no estás seguro, dime y lo revisamos juntos antes de guardar.

Luego crea la clave para el contenedor: **Settings → Keys → Generate auth key**. Deja **Reusable** y **Ephemeral** apagados, en **Tags** elige `tag:musica`, y copia la clave. La vas a pegar en el `.env` (paso 5), no en el chat.

## 3. Correo que envía los códigos (Gmail)

Usamos `elbunkerservers@gmail.com` como remitente, pero con una clave **propia de esta app** (así no compartes la de Valheim y puedes borrarla sin afectar nada):

1. Entra a la cuenta de Google de ese correo → **Seguridad → Verificación en 2 pasos** (debe estar activada).
2. Busca **Contraseñas de aplicaciones** → crea una llamada "El Bunker Sound".
3. Google te muestra 16 letras. Cópialas **sin espacios**: es el `SMTP_PASS` del `.env`.

## 4. Entrar con Google (opcional)

Si no lo configuras, la app funciona igual con el código por correo. Si lo quieres:

1. https://console.cloud.google.com → proyecto nuevo "El Bunker Sound".
2. **APIs y servicios → Pantalla de consentimiento de OAuth** → tipo **Externo**. Deja el estado en **Pruebas** y agrega como "Usuarios de prueba" los Gmail de tus amigos (hasta 100).
3. **Credenciales → Crear credenciales → ID de cliente de OAuth → Aplicación web**. En **URI de redirección autorizados** pon exactamente:
   `https://musica.TU-TAILNET.ts.net/api/auth/google/callback`
4. Copia el ID y el secreto al `.env` (`GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`).

> Aviso honesto: no he podido probar esto contra Google real, y en iPhone puede comportarse raro dentro de la app instalada. El código por correo es lo más seguro.

## 5. Tu archivo `.env`

```bash
cd ~/el-bunker-sounds
cp .env.example .env
nano .env
```
Rellena: `BASE_URL`, `ADMIN_EMAILS` (tu correo), `MUSIC_HOST_DIR`, `TS_AUTHKEY`, `SMTP_PASS` y, si quieres, las claves de Google. (Guardar en nano: `Ctrl+O`, Enter, `Ctrl+X`.)

`BASE_URL` es el nombre del nodo: normalmente `https://musica.tailfd4430.ts.net`. Si cambia, lo ves en el panel de Tailscale → Machines.

## 6. Pasar tu música al servidor

Tu música está en OneDrive. La forma más cómoda es que el **servidor la baje directo desde OneDrive** con `rclone` (gratis), sin encender tu PC:

**a) En el servidor:**
```bash
sudo apt install -y rclone
```
**b) En tu PC con Windows** (PowerShell):
```powershell
winget install Rclone.Rclone
rclone authorize "onedrive"
```
Se abre el navegador, inicias sesión en tu OneDrive y la ventana muestra un texto largo entre `---->` y `<----` (es un "token"). Cópialo.

**c) En el servidor:**
```bash
rclone config
```
Responde: `n` (nuevo) → nombre `onedrive` → tipo `onedrive` → deja vacíos client id y secret → región `1` → "Edit advanced config" `n` → **"Use web browser to automatically authenticate" → `n`** → pega el token → elige **OneDrive Personal** y la unidad que te muestre → `y` para confirmar.

Prueba que ve tus archivos:
```bash
rclone ls "onedrive:Documents/03. iA/El Bunker Sound" | head
```
**d)** En el `.env` agrega:
```
ONEDRIVE_REMOTE="onedrive:Documents/03. iA/El Bunker Sound"
MUSIC_HOST_DIR=/home/tansis/musica
```
y corre `./scripts/sincronizar-musica.sh`. Cada vez que agregues canciones en OneDrive, vuelves a correr ese script (solo copia lo nuevo y **no borra nada**).

> Alternativa: instalar Tailscale en tu PC y copiar con `scp` o WinSCP. Dime si prefieres esa.

Espacio aproximado: tus WAV + unas 5 veces menos en copias M4A (3 GB → ~0.6 GB extra). Revisa con `df -h`.

## 7. Encender la app

```bash
./actualizar.sh
```
Cuando termine, abre la dirección de `BASE_URL` en tu celular, escribe tu correo (el de `ADMIN_EMAILS`) y el código que llega. Entras como administrador. En **Administración** ves cómo avanza la conversión de las canciones.

## 8. Invitar amigos

Mándales la dirección. Ellos escriben su correo (o entran con Google), y tú los **apruebas en Administración** (también te llega un correo cuando alguien pide entrar). Mientras no los apruebes, no ven ni escuchan nada. Puedes bloquear o eliminar a cualquiera cuando quieras.

**En Android:** abrir la dirección en Chrome. La app muestra un aviso con el botón **Instalar** (o, si el navegador no lo ofrece, te dice que uses el menú ⋮ → *Instalar app*). Queda en la pantalla de inicio como una app más y, en Android, sí se mantiene vertical sola.

**En iPhone:** abrir la dirección en Safari → botón **Compartir** → **Agregar a pantalla de inicio**. Luego abrir la app desde el ícono y entrar ahí (en iPhone, la app instalada no comparte la sesión con Safari).

## 9. Actualizar y respaldar

- Actualizar: `cd ~/el-bunker-sounds && ./actualizar.sh`
- Respaldo de cuentas, favoritos y listas (la música original no se toca):
  ```bash
  docker run --rm -v el-bunker-sounds_app-data:/d -v "$PWD":/b alpine tar czf /b/respaldo-bunker-sound.tgz -C /d .
  ```
- Ver registros: `docker compose logs --tail=50 app`

## Si algo falla

| Síntoma | Qué mirar |
|---|---|
| No llega el código al correo | Revisa spam; `docker compose logs app` y confirma `SMTP_PASS` (16 letras sin espacios). |
| La dirección no abre desde fuera | En Tailscale, la máquina `musica` debe estar conectada y con Funnel activo (`docker compose logs tailscale`). Revisa el paso 2. |
| Una canción dice "Preparando audio…" mucho rato | Administración → "Reintentar errores". Si sigue, mira el motivo que aparece ahí. |
| No aparece música nueva | Administración → "Buscar música nueva". La carpeta debe contener `Artista/<Artista>/...`. |
