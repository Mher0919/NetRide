# backend/Dockerfile
#
# Builds the Node backend WITH an embedded, in-process OSRM road network
# (Greater LA / SoCal) baked into the image. This removes the need for a
# separate always-on OSRM routing service — the routing engine runs inside
# the Node process (src/modules/routing/local-osrm.engine.ts via @osrm/osrm),
# which is faster (no network hop) and free-tier friendly.
#
# Result: OSRM_DATA_PATH defaults to ./data/la.osrm and is produced below.

# ---- Stage 1: fetch the OSM extract (Node/alpine has wget) -----------------
# Default: Los Angeles County only (~60MB) — covers the core operating area
# with identical road quality but a ~10x lighter/faster build than SoCal.
# Override OSM_PBF / REGION to target a larger area when needed.
# The downloaded PBF is cached across builds (BuildKit cache mount) so a
# code-only redeploy never re-downloads it.
FROM node:20-alpine AS pbf-fetcher
WORKDIR /osrm
ARG REGION=la
ARG OSM_PBF=https://download.geofabrik.de/north-america/us/california/los-angeles-latest.osm.pbf
RUN --mount=type=cache,target=/osrm/cache \
    wget -q -O /osrm/cache/region.osm.pbf "${OSM_PBF}" && \
    cp /osrm/cache/region.osm.pbf /osrm/region.osm.pbf

# ---- Stage 2: build the OSRM road-network extract --------------------------
FROM ghcr.io/project-osrm/osrm-backend:latest AS osrm-builder
WORKDIR /osrm
ARG REGION=la
# The osrm-backend image has neither curl nor wget, so we download the PBF
# in the pbf-fetcher stage (alpine) and copy it in here.
COPY --from=pbf-fetcher /osrm/region.osm.pbf /osrm/region.osm.pbf
# Cache the extract output so a code-only redeploy reuses the built network
# instead of re-running osrm-extract/partition/customize (the slow part).
RUN --mount=type=cache,target=/osrm/cache \
    if [ -f /osrm/cache/${REGION}.osrm ]; then \
      cp /osrm/cache/${REGION}.osrm /osrm/${REGION}.osrm; \
    else \
      osrm-extract -p /opt/car.lua region.osm.pbf && \
      osrm-partition region.osrm && \
      osrm-customize region.osrm && \
      mv region.osrm /osrm/${REGION}.osrm && \
      cp /osrm/${REGION}.osrm /osrm/cache/${REGION}.osrm; \
    fi

# ---- Stage 2: build the Node backend ---------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Native build tooling for prisma + @osrm/osrm (which compiles libosmium via
# cmake/node-gyp). Kept in the build stage so the runtime image stays lean.
RUN apk add --no-cache \
    build-base python3 make g++ libc6-compat \
    cmake boost-dev expat-dev libxml2-dev zlib-dev \
    && rm -rf /var/cache/apk/*

COPY package*.json ./
# Install optional @osrm/osrm too (skip if it can't build on this platform).
RUN npm install || npm install --no-optional

COPY . .

# Bake the road network from the osrm-builder stage.
COPY --from=osrm-builder /osrm/*.osrm ./data/
RUN npx prisma generate && npm run build

# ---- Stage 3: lean runtime ------------------------------------------------
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
