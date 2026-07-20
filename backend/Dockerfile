# backend/Dockerfile
#
# Builds the Node backend. The routing engine (OpenRouteService) is an
# external API — no local OSRM sidecar, no baked road network, no C++
# toolchain needed. This is a standard two-stage Node Docker build.
#
# All ORS requests originate FROM the backend and never expose the API
# key to the Flutter app.

# ---- Stage 1: build --------------------------------------------------------
FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

# ---- Stage 2: runtime ------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

RUN mkdir -p /app/uploads

EXPOSE 3000

CMD ["node", "dist/app.js"]
