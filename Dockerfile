# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL} \
    VITE_SUPABASE_PUBLISHABLE_KEY=${VITE_SUPABASE_PUBLISHABLE_KEY}
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/production-agent/package.json apps/production-agent/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/production-assets/package.json packages/production-assets/package.json
COPY packages/production-contracts/package.json packages/production-contracts/package.json
RUN npm install --global npm@11.6.2 --no-audit --no-fund
# El repositorio fija npm 11; npm 10 (incluido en algunas imágenes Node 22)
# rechaza el lock por los peers opcionales multiplataforma de Rolldown (@emnapi).
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN test -n "$VITE_SUPABASE_URL" \
  && test -n "$VITE_SUPABASE_PUBLISHABLE_KEY" \
  && npm run build

FROM node:22-bookworm-slim
ARG TARGETARCH
ARG MEDIAMTX_VERSION=1.21.0
ENV NODE_ENV=production \
    KPL_DATA_DIR=/app/data \
    KPL_WEB_DIST=/app/apps/web/dist \
    KPL_PILOT_FFMPEG_PATH=/usr/bin/ffmpeg \
    KPL_PILOT_MEDIAMTX_PATH=/usr/local/bin/mediamtx
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
  && arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
  && case "$arch" in amd64|arm64) ;; *) echo "Arquitectura no soportada: $arch" >&2; exit 1 ;; esac \
  && curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_${arch}.tar.gz" \
     | tar -xz -C /usr/local/bin mediamtx \
  && chmod 0755 /usr/local/bin/mediamtx \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
RUN mkdir -p /app/data && chmod 0770 /app/data
EXPOSE 4310/tcp 8889/tcp 8189/udp
VOLUME ["/app/data"]
CMD ["node", "apps/server/dist/pilot-index.js"]
