import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

// Primary client — configured with DATABASE_URL as directUrl for writes.
// When DATABASE_REPLICA_URL is set, Prisma's read-replica feature routes
// reads to the replica and writes/transactions to the primary.
export const prisma = new PrismaClient({
  datasources: env.DATABASE_REPLICA_URL
    ? {
        db: {
          url: env.DATABASE_REPLICA_URL,
        },
      }
    : undefined,
});

// Explicit primary client for queries that must read their own writes
// (matching, accept-trip, etc.). Falls back to the default client when
// no replica is configured.
export const primaryPrisma = new PrismaClient();
