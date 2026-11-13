# El Búnker Sound — imagen liviana: Node 22 + ffmpeg (para convertir WAV a M4A).
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY web ./web

# /data guarda la base de datos, las copias M4A y las carátulas reducidas. /music se monta solo lectura.
RUN mkdir -p /data /music && chown -R node:node /data /app
USER node
ENV NODE_ENV=production PORT=3000 HOST=127.0.0.1 MUSIC_DIR=/music DATA_DIR=/data NODE_OPTIONS=--disable-warning=ExperimentalWarning

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/auth/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
