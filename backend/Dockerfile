# backend/Dockerfile
#
# Builds the Node backend WITH an embedded, in-process OSRM road network
# (Greater LA / SoCal) baked into the image. This removes the need for a
# separate always-on OSRM routing service — the routing engine runs inside
# the Node process (src/modules/routing/local-osrm.engine.ts via @osrm/osrm),
# which is faster (no network hop) and free-tier friendly.
#
# Result: OSRM_DATA_PATH defaults to ./data/la.osrm. The CH road network
# (backend/data/la.osrm) is pre-baked ONCE and committed via Git LFS, then
# copied straight into the image — NO download or osrm-extract at build time,
# so every deploy is fast and free-tier friendly. To rebuild the network,
# run scripts/rebuild-osrm.sh locally (needs Docker) and re-commit la.osrm.

ARG REGION=la

# ---- Stage 1: build the Node backend ---------------------------------------
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

# Copy the pre-baked CH road network (tracked in Git LFS) into the image.
COPY ./data/${REGION}.osrm ./data/${REGION}.osrm
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
