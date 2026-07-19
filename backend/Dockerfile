# backend/Dockerfile
FROM node:20-alpine

WORKDIR /app

# System libs required by `canvas` (face-api.js image decoding in Node)
# and build tooling for native modules (tfjs-node, canvas, prisma).
# Runtime shared libs (cairo, pango, etc. WITHOUT the -dev suffix) must be
# present at runtime for canvas.node to load (libcairo.so.2, etc.).
RUN apk add --no-cache \
    build-base \
    cairo-dev \
    cairo \
    pango-dev \
    pango \
    jpeg-dev \
    jpeg \
    giflib-dev \
    giflib \
    librsvg-dev \
    librsvg \
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

# Pre-bake the face-api.js model weights into the image so the first face
# check never fetches them from GitHub at request time (which caused request
# timeouts). faceMatcher.ts reads them from <__dirname>/faceModels, i.e.
# dist/services/faceModels.
RUN mkdir -p /app/dist/services/faceModels \
  && BASE=https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights \
  && for f in \
       tiny_face_detector_model-weights_manifest.json \
       tiny_face_detector_model-shard1 \
       face_recognition_model-weights_manifest.json \
       face_recognition_model-shard1 \
       face_recognition_model-shard2 ; do \
       curl -fsSL "$BASE/$f" -o "/app/dist/services/faceModels/$f" || echo "WARN: failed to fetch $f"; \
     done \
  && ls -la /app/dist/services/faceModels

# Create uploads directory for Render persistent disk
RUN mkdir -p /app/uploads

EXPOSE 3000

# Use compiled output (dist/app.js), NOT ts-node for production
CMD ["node", "dist/app.js"]