#!/usr/bin/env bash
# Actualiza El Búnker Sound en el servidor: baja lo nuevo de GitHub, reconstruye y reinicia.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "❌ Falta el archivo .env. Haz:  cp .env.example .env  y rellénalo (mira docs/SERVIDOR.md)."
  exit 1
fi

echo "⬇️  Bajando cambios de GitHub…"
git pull --ff-only

echo "🔨 Construyendo la app…"
docker compose build

echo "🚀 Reiniciando…"
docker compose up -d --remove-orphans
docker image prune -f >/dev/null 2>&1 || true

echo "⏳ Esperando que la app responda…"
for i in $(seq 1 30); do
  state=$(docker inspect -f '{{.State.Health.Status}}' bunker-sound-app 2>/dev/null || echo "starting")
  if [ "$state" = "healthy" ]; then
    echo "✅ Listo. Abre la dirección de BASE_URL en tu celular."
    docker compose ps
    exit 0
  fi
  sleep 2
done
echo "⚠️  La app no quedó 'healthy' en 60 s. Mira los registros con:  docker compose logs --tail=50 app"
exit 1
