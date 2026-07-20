# backend/Dockerfile
#
# Builds the Node backend WITH an embedded, in-process OSRM road network
# (Greater LA) served by the official `osrm-routed` binary running as a
# sidecar INSIDE the same container (127.0.0.1:5000). This removes the need
# for a separate always-on OSRM routing service — the routing engine is in
# the same container, no network hop to the outside world, sub-50ms
# responses, and the same contraction-hierarchy geometry OSRM serves in
# production. Free-tier friendly: one container, one process tree.
#
# The CH road network (backend/data/la.osrm + sidecars) is pre-baked ONCE and
# committed via Git LFS, then copied straight into the image — NO download or
# osrm-extract at build time, so deploys are fast. Fallback: if la.osrm is
# absent, the build downloads the lightweight LA extract (~203MB BBBike) and
# runs the CH pipeline (extract + contract) at build time. Either way the
# engine needs ./data/la.osrm (+ sidecars) present before launch.
#
# To rebuild the network: scripts/rebuild-osrm.sh (needs Docker), then commit
# data/la.osrm* (Git LFS stores the blobs).

ARG REGION=la

# ---- Stage 0: build (or copy) the CH road network --------------------------
# Debian-based osrm-backend image has all shared libs the CLI needs.
FROM ghcr.io/project-osrm/osrm-backend:latest AS osrm-builder
WORKDIR /osrm
ARG REGION
# Bring in the repo so we can check for a pre-baked (Git LFS) la.osrm family.
COPY . .
RUN if [ -s "./data/${REGION}.osrm.hsgr" ]; then \
      echo "Using pre-baked ${REGION}.osrm family"; \
      for f in data/${REGION}.osrm*; do cp "$f" "/osrm/$(basename "$f")"; done; \
    else \
      echo "Pre-baked ${REGION}.osrm not found — downloading + building at build time"; \
      apt-get update -qq && apt-get install -y -qq wget >/dev/null 2>&1; \
      wget -q --tries=5 --timeout=300 -O region.osm.pbf \
        "https://download.bbbike.org/osm/bbbike/LosAngeles/LosAngeles.osm.pbf" && \
      if [ ! -s region.osm.pbf ] || [ "$(stat -c%s region.osm.pbf)" -lt 10000000 ]; then \
        echo "ERROR: downloaded PBF missing or too small"; exit 1; \
      fi && \
      osrm-extract -p /opt/car.lua region.osm.pbf && \
      osrm-contract region.osrm; \
      if [ ! -s "region.osrm.hsgr" ]; then echo "ERROR: contracted graph (region.osrm.hsgr) not produced"; ls -la /osrm; exit 1; fi && \
      touch region.osrm && \
      for f in region.osrm*; do mv "$f" "/osrm/${REGION}.osrm${f#region.osrm}"; done; \
    fi

# ---- Stage 1: build the Node backend (glibc/Debian for osrm-routed compat) --
FROM node:20-bookworm-slim AS builder
WORKDIR /app
ARG REGION

RUN apt-get update -qq && apt-get install -y -qq \
    build-essential python3 make cmake libboost-dev libexpat-dev libxml2-dev zlib1g-dev \
    && rm -rf /var/cache/apt/*

COPY package*.json ./
# Install deps (no reliance on the unmaintained native @osrm/osrm addon).
RUN npm install

COPY . .
# The road network from the osrm-builder stage (pre-baked or freshly built).
COPY --from=osrm-builder /osrm/${REGION}.osrm ./data/${REGION}.osrm
COPY --from=osrm-builder /osrm/${REGION}.osrm.hsgr ./data/${REGION}.osrm.hsgr
COPY --from=osrm-builder /osrm/${REGION}.osrm.ebg ./data/${REGION}.osrm.ebg
COPY --from=osrm-builder /osrm/${REGION}.osrm.ebg_nodes ./data/${REGION}.osrm.ebg_nodes
COPY --from=osrm-builder /osrm/${REGION}.osrm.edges ./data/${REGION}.osrm.edges
COPY --from=osrm-builder /osrm/${REGION}.osrm.enw ./data/${REGION}.osrm.enw
COPY --from=osrm-builder /osrm/${REGION}.osrm.geometry ./data/${REGION}.osrm.geometry
COPY --from=osrm-builder /osrm/${REGION}.osrm.nbg_nodes ./data/${REGION}.osrm.nbg_nodes
COPY --from=osrm-builder /osrm/${REGION}.osrm.icd ./data/${REGION}.osrm.icd
COPY --from=osrm-builder /osrm/${REGION}.osrm.names ./data/${REGION}.osrm.names
COPY --from=osrm-builder /osrm/${REGION}.osrm.ramIndex ./data/${REGION}.osrm.ramIndex
COPY --from=osrm-builder /osrm/${REGION}.osrm.fileIndex ./data/${REGION}.osrm.fileIndex
COPY --from=osrm-builder /osrm/${REGION}.osrm.properties ./data/${REGION}.osrm.properties
COPY --from=osrm-builder /osrm/${REGION}.osrm.timestamp ./data/${REGION}.osrm.timestamp
COPY --from=osrm-builder /osrm/${REGION}.osrm.datasource_names ./data/${REGION}.osrm.datasource_names
COPY --from=osrm-builder /osrm/${REGION}.osrm.restrictions ./data/${REGION}.osrm.restrictions
COPY --from=osrm-builder /osrm/${REGION}.osrm.tld ./data/${REGION}.osrm.tld
COPY --from=osrm-builder /osrm/${REGION}.osrm.tls ./data/${REGION}.osrm.tls
COPY --from=osrm-builder /osrm/${REGION}.osrm.cnbg ./data/${REGION}.osrm.cnbg
COPY --from=osrm-builder /osrm/${REGION}.osrm.cnbg_to_ebg ./data/${REGION}.osrm.cnbg_to_ebg
COPY --from=osrm-builder /osrm/${REGION}.osrm.maneuver_overrides ./data/${REGION}.osrm.maneuver_overrides
COPY --from=osrm-builder /osrm/${REGION}.osrm.turn_penalties_index ./data/${REGION}.osrm.turn_penalties_index
COPY --from=osrm-builder /osrm/${REGION}.osrm.turn_weight_penalties ./data/${REGION}.osrm.turn_weight_penalties
COPY --from=osrm-builder /osrm/${REGION}.osrm.turn_duration_penalties ./data/${REGION}.osrm.turn_duration_penalties

RUN npx prisma generate && npm run build

# ---- Stage 2: runtime (Debian/glibc — ships osrm-routed + all libs) -------
# Based on the OSRM image so osrm-routed + its native libs are present; we
# inject the Node runtime (glibc-compatible, built on bookworm above) by
# copying the node binary + global modules from the builder stage.
FROM ghcr.io/project-osrm/osrm-backend:latest AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV OSRM_DATA_PATH=./data/la.osrm
ENV OSRM_ROUTED_URL=http://127.0.0.1:5000

# Node runtime from the bookworm builder (same glibc family as Debian).
COPY --from=builder /usr/local/bin/node /usr/local/bin/node
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm 2>/dev/null || true

# The built Node app (glibc-compatible, built on bookworm above).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/data ./data
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma

# Entrypoint: start osrm-routed sidecar (loads the baked CH graph) in the
# background, wait for it to answer, then launch the Node server.
RUN printf '#!/usr/bin/env bash\nset -e\n' > /entrypoint.sh && \
    printf 'REGION="${REGION:-la}"\n' >> /entrypoint.sh && \
    printf 'echo "[entrypoint] starting osrm-routed on 127.0.0.1:5000"\n' >> /entrypoint.sh && \
    printf 'osrm-routed --algorithm CH "./data/${REGION}.osrm" --ip 127.0.0.1 --port 5000 > /var/log/osrm-routed.log 2>&1 &\n' >> /entrypoint.sh && \
    printf 'for i in $(seq 1 180); do\n' >> /entrypoint.sh && \
    printf '  if node -e "require('"'"'http'"'"').get('"'"'http://127.0.0.1:5000/'"'"',r=>process.exit(r.statusCode===200?0:1)).on('"'"'error'"'"',()=>process.exit(1))" >/dev/null 2>&1; then echo "[entrypoint] osrm-routed is ready"; break; fi\n' >> /entrypoint.sh && \
    printf '  sleep 1\n' >> /entrypoint.sh && \
    printf 'done\n' >> /entrypoint.sh && \
    printf 'if ! node -e "require('"'"'http'"'"').get('"'"'http://127.0.0.1:5000/'"'"',r=>process.exit(r.statusCode===200?0:1)).on('"'"'error'"'"',()=>process.exit(1))" >/dev/null 2>&1; then echo "[entrypoint] ERROR: osrm-routed did not start. Log:"; cat /var/log/osrm-routed.log; fi\n' >> /entrypoint.sh && \
    printf 'echo "[entrypoint] launching node server"\n' >> /entrypoint.sh && \
    printf 'exec node dist/app.js\n' >> /entrypoint.sh && \
    chmod +x /entrypoint.sh

RUN mkdir -p /app/uploads

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
