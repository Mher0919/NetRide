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
      if [ ! -f region.osrm ]; then echo "ERROR: region.osrm not produced"; ls -la /osrm; exit 1; fi && \
      mv region.osrm "/osrm/${REGION}.osrm"; \
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
# Install optional @osrm/osrm too (skip if it can't build on this platform).
RUN npm install || npm install --no-optional

COPY . .
# The road network from the osrm-builder stage (pre-baked or freshly built).
COPY --from=osrm-builder /osrm/${REGION}.osrm ./data/${REGION}.osrm

RUN npx prisma generate && npm run build

# ---- Stage 2: lean runtime ------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV OSRM_DATA_PATH=./data/la.osrm

RUN apk add --no-cache libc6-compat zlib expat libxml2 boost-python3 \
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
