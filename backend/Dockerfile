# backend/Dockerfile
#
# Builds the Node backend WITH an embedded, in-process OSRM road network
# (Greater LA) baked into the image. This removes the need for a separate
# always-on OSRM routing service — the routing engine runs inside the Node
# process (src/modules/routing/local-osrm.engine.ts via @osrm/osrm), which
# is faster (no network hop) and free-tier friendly.
#
# Result: OSRM_DATA_PATH defaults to ./data/la.osrm. Preferred path: the CH
# road network (backend/data/la.osrm) is pre-baked ONCE and committed via Git
# LFS, then copied straight into the image — NO download/extract at build
# time, so deploys are fast. Fallback: if la.osrm is absent, the build
# downloads the lightweight LA extract (~203MB BBBike) and runs the CH
# pipeline (extract + contract) at build time. Either way the engine needs
# ./data/la.osrm present before npm run build.
#
# To rebuild the network: scripts/rebuild-osrm.sh (needs Docker), then commit
# data/la.osrm (Git LFS stores the blob).

ARG REGION=la

# ---- Stage 0: build (or copy) the CH road network --------------------------
# Debian-based osrm-backend image has all shared libs the CLI needs.
FROM ghcr.io/project-osrm/osrm-backend:latest AS osrm-builder
WORKDIR /osrm
ARG REGION
# Bring in the repo so we can check for a pre-baked (Git LFS) la.osrm.
COPY . .
RUN if [ -s "./data/${REGION}.osrm" ]; then \
      echo "Using pre-baked ${REGION}.osrm"; \
      cp "./data/${REGION}.osrm" "/osrm/${REGION}.osrm"; \
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

# ---- Stage 1: build the Node backend ---------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
ARG REGION

# Native build tooling for prisma + @osrm/osrm (compiles libosmium via
# cmake/node-gyp). Kept in the build stage so the runtime image stays lean.
RUN apk add --no-cache \
    build-base python3 make g++ libc6-compat \
    cmake boost-dev expat-dev libxml2-dev zlib-dev \
    && rm -rf /var/cache/apk/*

COPY package*.json ./
# Install app deps, then force-build the native @osrm/osrm addon from source
# (its prebuilds don't cover Node 20, so we compile libosmium in-tree).
# We verify the addon actually loads; if it doesn't, fail the build loudly
# instead of silently shipping a broken router.
RUN npm install
RUN npm install @osrm/osrm@^5.27.2 --build-from-source \
 && node -e "require('@osrm/osrm'); console.log('@osrm/osrm OK')" \
 || { echo "ERROR: @osrm/osrm native build/load failed"; exit 1; }

COPY . .
# The road network from the osrm-builder stage (pre-baked or freshly built).
# Copy the full family: base .osrm plus all sidecar files (la.osrm.hsgr, ...).
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

# ---- Stage 2: lean runtime ------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV OSRM_DATA_PATH=./data/la.osrm

RUN apk add --no-cache libc6-compat zlib expat libxml2 boost \
    && rm -rf /var/cache/apk/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/data ./data
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma

RUN mkdir -p /app/uploads

EXPOSE 3000

# Prefer the embedded OSRM; fall back to remote OSRM_URL only if set.
CMD ["node", "dist/app.js"]
