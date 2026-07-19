"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.query = exports.directPool = exports.pool = void 0;
// backend/src/config/database.ts
const pg_1 = require("pg");
const env_1 = require("./env");
// Direct (non-pooled) URL for session-mode queries (e.g. SET LOCAL).
// When unset, falls back to DATABASE_URL so dev single-DB keeps working.
const directUrl = env_1.env.DIRECT_DATABASE_URL || env_1.env.DATABASE_URL;
// Pool used for PgBouncer transaction-mode pooling. Disable statement
// cache so the pool can safely rotate connections through PgBouncer.
exports.pool = new pg_1.Pool({
    connectionString: directUrl,
    ssl: env_1.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});
// Direct pool for session-mode queries that bypass PgBouncer.
// Only used when DIRECT_DATABASE_URL is explicitly set.
exports.directPool = env_1.env.DIRECT_DATABASE_URL
    ? new pg_1.Pool({
        connectionString: env_1.env.DIRECT_DATABASE_URL,
        ssl: env_1.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    })
    : exports.pool;
console.log('🔌 Attempting to connect to database at:', env_1.env.DATABASE_URL.replace(/:[^:@/]+@/, ':****@'));
exports.pool.on('error', (err) => {
    console.error('⚠️ [DATABASE] Unexpected error on idle client:', err.message);
    // Do not process.exit(-1) here. The pool will handle reconnecting on the next query.
    // In development, idle connections are often terminated by Postgres or network resets.
});
const query = (text, params) => exports.pool.query(text, params);
exports.query = query;
//# sourceMappingURL=database.js.map