#!/usr/bin/env bash
# Copia tu música desde OneDrive al servidor usando rclone (gratis). Solo AGREGA o actualiza archivos; no borra nada.
# Antes: configura rclone una vez (mira docs/SERVIDOR.md, paso "Música") y define en .env:
#   ONEDRIVE_REMOTE="onedrive:Documents/03. iA/El Bunker Sound"
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
: "${ONEDRIVE_REMOTE:?Falta ONEDRIVE_REMOTE en .env}"
: "${MUSIC_HOST_DIR:?Falta MUSIC_HOST_DIR en .env}"
mkdir -p "$MUSIC_HOST_DIR"
rclone copy "$ONEDRIVE_REMOTE" "$MUSIC_HOST_DIR" --progress --transfers 2 --exclude "desktop.ini" --exclude "Thumbs.db"
chmod -R a+rX "$MUSIC_HOST_DIR"
echo "✅ Música copiada. La app la detecta sola en unos minutos (o toca “Buscar música nueva” en Administración)."
