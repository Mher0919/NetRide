# backend/Dockerfile
#
# Multi-stage build.
#   1. Build the Node backend
#   2. Build the LA OSRM road network (extract → partition → customize)
#   3. Runtime: OSRM image + Node.js + fresh LA data
#
# The OSRM data is rebuilt during Docker build using the same osrm-backend
# version that runs at runtime, guaranteeing compatibility.

# ---- Stage 1: Node build ----------------------------------------------------
FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

# ---- Stage 2: Build LA OSRM road network ------------------------------------
FROM ghcr.io/project-osrm/osrm-backend:v5.27.1 AS osrm-data

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /data

# Download Los Angeles OSM extract (~200MB compressed).
# BBBike LA extract covers Los Angeles, Orange, Ventura, San Bernardino,
# and Riverside counties — the entire greater LA ride-hailing area.
RUN curl -L -o la.osm.pbf \
    https://download.bbbike.org/osm/bbbike/LosAngeles/LosAngeles.osm.pbf

# Pre-process the OSM data into the OSRM routing graph.
RUN osrm-extract -p /opt/car.lua la.osm.pbf
RUN osrm-partition la.osrm
RUN osrm-customize la.osrm

# Clean up the source PBF to save space.
RUN rm la.osm.pbf

# ---- Stage 3: Runtime (OSRM base + Node + fresh data) -----------------------
FROM ghcr.io/project-osrm/osrm-backend:v5.27.1 AS runtime

# Install Node.js 20 from NodeSource.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Copy freshly built OSRM road network.
COPY --from=osrm-data /data/ ./data/

# Startup script runs osrm-routed then Node.
COPY scripts/start.sh /start.sh
RUN chmod +x /start.sh

RUN mkdir -p /app/uploads

EXPOSE 3000 5000

CMD ["/start.sh"]
