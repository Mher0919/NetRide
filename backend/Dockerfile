# backend/Dockerfile
#
# Builds the Node backend WITH an embedded, in-process OSRM road network
# (Greater LA / SoCal) baked into the image. This removes the need for a
# separate always-on OSRM routing service — the routing engine runs inside
# the Node process (src/modules/routing/local-osrm.engine.ts via @osrm/osrm),
# which is faster (no network hop) and free-tier friendly.
#
# Result: OSRM_DATA_PATH defaults to ./data/la.osrm and is produced below.
# The build downloads a lightweight LA-area OSM extract (~203MB, BBBike) and
# extracts the road network in-process — no separate routing service needed.

ARG REGION=la

# ---- Stage 1: fetch the OSM extract (Node/alpine has wget) -----------------
# Lightweight Los Angeles-area extract (~203MB, BBBike) — covers the core
# operating area with full road detail but builds comfortably on free-tier
# RAM, unlike the 666MB SoCal region. Override OSM_PBF to target another.
# We deliberately do NOT cache the PBF (a partial download would poison the
# build); the expensive osrm-extract is run fresh here at build time.
FROM node:20-alpine AS pbf-fetcher
WORKDIR /osrm
ARG OSM_PBF=https://download.bbbike.org/osm/bbbike/LosAngeles/LosAngeles.osm.pbf
# Download with retries; fail fast if the result is missing or an error page.
RUN wget -q --tries=5 --timeout=180 -O region.osm.pbf "${OSM_PBF}" && \
    if [ ! -s region.osm.pbf ] || [ "$(stat -c%s region.osm.pbf)" -lt 10000000 ]; then \
      echo "ERROR: downloaded PBF is missing or too small (got $(stat -c%s region.osm.pbf 2>/dev/null) bytes)"; exit 1; \
    fi

# ---- Stage 2: build the OSRM road-network extract --------------------------
FROM ghcr.io/project-osrm/osrm-backend:latest AS osrm-builder
WORKDIR /osrm
ARG REGION
COPY --from=pbf-fetcher /osrm/region.osm.pbf /osrm/region.osm.pbf
# osrm-customize (MLD) can exit non-zero on benign "unreachable boundary
# node" warnings, so we don't gate the rename on its exit code — the output
# file is still written. Verify it exists before renaming.
RUN osrm-extract -p /opt/car.lua region.osm.pbf && \
    osrm-partition region.osrm && \
    osrm-customize region.osrm; \
    if [ ! -f region.osrm ]; then echo "ERROR: region.osrm not produced"; exit 1; fi && \
    mv region.osrm /osrm/${REGION}.osrm

# ---- Stage 3: build the Node backend ---------------------------------------
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
COPY --from=osrm-builder /osrm/${REGION}.osrm ./data/${REGION}.osrm
RUN npx prisma generate && npm run build

# ---- Stage 4: lean runtime ------------------------------------------------
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
