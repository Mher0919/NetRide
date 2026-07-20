# backend/Dockerfile
#
# Multi-stage build.
#   1. Build the Node backend
#   2. Extract osrm-routed from the official OSRM image
#   3. Runtime image with Node + OSRM sidecar
#
# The LA OSM extract and pre-processed OSRM graph (.osrm family) are
# baked into the image during the build. At startup, start.sh launches
# osrm-routed with LA data, waits for it to be ready, then starts Node.

# ---- Stage 1: Node build ----------------------------------------------------
FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

# ---- Stage 2: OSRM binary extract -------------------------------------------
FROM ghcr.io/project-osrm/osrm-backend:v5.27.1 AS osrm

# ---- Stage 3: Runtime -------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Install osrm-routed and its shared libs from the OSRM image.
COPY --from=osrm /usr/local/bin/osrm-routed /usr/local/bin/osrm-routed
RUN ldd /usr/local/bin/osrm-routed 2>/dev/null | \
    awk '/=> \// {print $3}' | xargs -r dirname | sort -u | \
    xargs -r sh -c 'for d; do mkdir -p "$d" 2>/dev/null; done' && \
    ldd /usr/local/bin/osrm-routed 2>/dev/null | \
    awk '/=> \// {print $3}' | xargs -r -I{} cp {} /usr/local/lib/ 2>/dev/null || true

# If the ldd approach fails, copy the minimal required shared libs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libboost-program-options-dev libtbb2 libgomp1 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy Node build artifacts.
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Copy OSRM data (pre-processed LA road network).
COPY data/ ./data/

# Copy startup script.
COPY scripts/start.sh /start.sh
RUN chmod +x /start.sh

RUN mkdir -p /app/uploads

EXPOSE 3000 5000

CMD ["/start.sh"]
