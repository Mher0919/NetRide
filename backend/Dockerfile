# backend/Dockerfile
FROM node:20-alpine

WORKDIR /app

# Build tooling for native modules (prisma) + python for node-gyp.
RUN apk add --no-cache \
    build-base \
    python3 \
    make \
    g++ \
    libc6-compat \
    && rm -rf /var/cache/apk/*

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Generate Prisma Client for the target runtime
RUN npx prisma generate

# Build TypeScript
RUN npm run build

# Create uploads directory for Render persistent disk
RUN mkdir -p /app/uploads

EXPOSE 3000

# Use compiled output (dist/app.js), NOT ts-node for production
CMD ["node", "dist/app.js"]
