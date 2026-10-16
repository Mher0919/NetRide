# backend/Dockerfile
#
# Node.js backend image (single service).

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

COPY --from=builder --chown=node:node /app/package*.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/migrations ./migrations
# start.sh stays root-owned but only needs the executable bit for the node
# user; it is never writable by the runtime user.
COPY --chown=root:root scripts/start.sh /start.sh
RUN chmod 0555 /start.sh

# Local upload fallback dir must be writable by the unprivileged runtime
# user. Everything else under /app is read-only for `node`.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

# Never run the API/workers as root: a remote-code-execution bug in any
# dependency must not land as uid 0 in the container.
USER node

EXPOSE 3000

CMD ["/start.sh"]
