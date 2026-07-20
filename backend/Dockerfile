# backend/Dockerfile
#
# Builds the Node backend WITH an embedded, in-process OSRM road network
# (Greater LA / SoCal) baked into the image. This removes the need for a
# separate always-on OSRM routing service — the routing engine runs inside
# the Node process (src/modules/routing/local-osrm.engine.ts via @osrm/osrm),
# which is faster (no network hop) and free-tier friendly.
#
# Result: OSRM_DATA_PATH defaults to ./data/socal.osrm and is produced below.

# ---- Stage 1: build the OSRM road-network extract --------------------------
FROM ghcr.io/project-osrm/osrm-backend:latest AS osrm-builder
WORKDIR /osrm
# Default: SoCal extract. Override REGION / OSM_PBF to target elsewhere.
ARG REGION=socal
ARG OSM_PBF=https://download.geofabrik.de/north-america/us/california/socal-latest.osm.pbf
# The osrm-backend image is Debian-based and ships wget, not curl.
RUN wget -q -O region.osm.pbf "${OSM_PBF}"
RUN osrm-extract -p /opt/car.lua region.osm.pbf && \
    osrm-partition region.osrm && \
    osrm-customize region.osrm
RUN mv region.osrm /osrm/${REGION}.osrm

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
ENV OSRM_DATA_PATH=./data/socal.osrm

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
