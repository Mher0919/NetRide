// backend/src/config/database.ts
import { Pool } from 'pg';
import { env } from './env';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

console.log('🔌 Attempting to connect to database at:', env.DATABASE_URL.replace(/:[^:@/]+@/, ':****@'));

pool.on('error', (err) => {
  console.error('⚠️ [DATABASE] Unexpected error on idle client:', err.message);
  // Do not process.exit(-1) here. The pool will handle reconnecting on the next query.
  // In development, idle connections are often terminated by Postgres or network resets.
});

export const query = (text: string, params?: any[]) => pool.query(text, params);