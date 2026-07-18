# backend/Dockerfile
FROM node:20-alpine

WORKDIR /app

# System libs required by `canvas` (face-api.js image decoding in Node)
# and build tooling for native modules (tfjs-node, canvas, prisma).
RUN apk add --no-cache \
    build-base \
    cairo-dev \
    pango-dev \
    jpeg-dev \
    giflib-dev \
    librsvg-dev \
    python3 \
    make \
    g++ \
    && rm -rf /var/cache/apk/*

# Copy package files
COPY package*.json ./

# Install dependencies (incl. face-api.js, tfjs-node, canvas)
RUN npm install

# Copy source code
COPY . .

# Generate Prisma Client for the target runtime
RUN npx prisma generate

# Build TypeScript
RUN npm run build

# Pre-download face-api.js model weights so the first face check doesn't
# need outbound network at request time. The model loader also fetches
# on demand if these are missing.
RUN node -e "require('./dist/services/faceMatcher').loadFaceModels().then(()=>console.log('face models ready')).catch(e=>{console.warn('model preload skipped:',e.message)})" || true

# Create uploads directory for Render persistent disk
RUN mkdir -p /app/uploads

EXPOSE 3000

# Use compiled output (dist/app.js), NOT ts-node for production
CMD ["node", "dist/app.js"]