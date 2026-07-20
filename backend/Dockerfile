# backend/Dockerfile
#
# Multi-stage build.
#   1. Build the Node backend (Node 20 slim)
#   2. Runtime: OSRM image + Node.js 20
#
# Using the OSRM image as the base ensures all osrm-routed shared libraries
# are available without fighting package compatibility. Node.js is installed
# from NodeSource on top of the OSRM image.
#
# At startup, start.sh launches osrm-routed with the LA road network, waits
# for it to be ready, then starts the Node backend.

# ---- Stage 1: Node build ----------------------------------------------------
FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

# ---- Stage 2: Runtime (OSRM base + Node) ------------------------------------
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

# Copy OSRM road-network data (pre-processed LA extract).
COPY data/ ./data/

# Startup script runs osrm-routed then Node.
COPY scripts/start.sh /start.sh
RUN chmod +x /start.sh

RUN mkdir -p /app/uploads

EXPOSE 3000 5000

CMD ["/start.sh"]
