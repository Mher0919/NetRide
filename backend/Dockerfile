# backend/Dockerfile
#
# Node.js backend only. OSRM runs as a separate Render service.

# ---- Build stage -----------------------------------------------------------
FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

# ---- Runtime stage ---------------------------------------------------------
FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/migrations ./migrations
COPY scripts/start.sh /start.sh
RUN chmod +x /start.sh

RUN mkdir -p /app/uploads

EXPOSE 3000

CMD ["/start.sh"]
