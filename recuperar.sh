#!/usr/bin/env bash
# Si la app no abre después de reiniciar el servidor: vuelve a levantar Tailscale y la app, en el orden correcto.
# No borra datos ni música (están en volúmenes aparte) ni la sesión de Tailscale.
set -euo pipefail
cd "$(dirname "$0")"
echo "🔄 Reiniciando Tailscale y la app…"
docker compose up -d --force-recreate tailscale app
echo "⏳ Esperando que Tailscale se conecte…"
for i in $(seq 1 30); do
  if docker exec bunker-sound-ts tailscale --socket=/tmp/tailscaled.sock status >/dev/null 2>&1; then
    echo "✅ Tailscale conectado."
    docker compose ps
    exit 0
  fi
  sleep 2
done
echo "⚠️  Tailscale no se conectó en 60 s. Mira:  docker compose logs --tail=40 tailscale"
exit 1
