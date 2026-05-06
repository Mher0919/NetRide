"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.query = exports.pool = void 0;
// backend/src/config/database.ts
const pg_1 = require("pg");
const env_1 = require("./env");
exports.pool = new pg_1.Pool({
    connectionString: env_1.env.DATABASE_URL,
    ssl: env_1.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});
console.log('🔌 Attempting to connect to database at:', env_1.env.DATABASE_URL.replace(/:[^:@/]+@/, ':****@'));
exports.pool.on('error', (err) => {
    console.error('⚠️ [DATABASE] Unexpected error on idle client:', err.message);
    // Do not process.exit(-1) here. The pool will handle reconnecting on the next query.
    // In development, idle connections are often terminated by Postgres or network resets.
});
const query = (text, params) => exports.pool.query(text, params);
exports.query = query;
//# sourceMappingURL=database.js.map