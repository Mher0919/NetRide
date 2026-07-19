"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.primaryPrisma = exports.prisma = void 0;
const client_1 = require("@prisma/client");
const env_1 = require("../config/env");
// Primary client — configured with DATABASE_URL as directUrl for writes.
// When DATABASE_REPLICA_URL is set, Prisma's read-replica feature routes
// reads to the replica and writes/transactions to the primary.
exports.prisma = new client_1.PrismaClient({
    datasources: env_1.env.DATABASE_REPLICA_URL
        ? {
            db: {
                url: env_1.env.DATABASE_REPLICA_URL,
            },
        }
        : undefined,
});
// Explicit primary client for queries that must read their own writes
// (matching, accept-trip, etc.). Falls back to the default client when
// no replica is configured.
exports.primaryPrisma = new client_1.PrismaClient();
//# sourceMappingURL=prisma.service.js.map