// backend/src/config/database.ts
import { Pool } from 'pg';
import { env } from './env';

// Direct (non-pooled) URL for session-mode queries (e.g. SET LOCAL).
// When unset, falls back to DATABASE_URL so dev single-DB keeps working.
const directUrl = env.DIRECT_DATABASE_URL || env.DATABASE_URL;

// Pool used for PgBouncer transaction-mode pooling. Disable statement
// cache so the pool can safely rotate connections through PgBouncer.
export const pool = new Pool({
  connectionString: directUrl,
  ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Direct pool for session-mode queries that bypass PgBouncer.
// Only used when DIRECT_DATABASE_URL is explicitly set.
export const directPool = env.DIRECT_DATABASE_URL
  ? new Pool({
      connectionString: env.DIRECT_DATABASE_URL,
      ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    })
  : pool;

console.log('🔌 Attempting to connect to database at:', env.DATABASE_URL.replace(/:[^:@/]+@/, ':****@'));

pool.on('error', (err) => {
  console.error('⚠️ [DATABASE] Unexpected error on idle client:', err.message);
  // Do not process.exit(-1) here. The pool will handle reconnecting on the next query.
  // In development, idle connections are often terminated by Postgres or network resets.
});

export const query = (text: string, params?: any[]) => pool.query(text, params);