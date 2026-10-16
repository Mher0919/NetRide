import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { resolveMigrationFilename } from '../security/safe-path';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function runMigration() {
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const migrationFile = process.argv[2] || '009_admin_and_audit_logs.sql';
  // The filename comes from the command line: reject traversal, absolute
  // paths and anything that does not resolve inside migrations/.
  const migrationPath = resolveMigrationFilename(migrationsDir, migrationFile);

  if (!migrationPath) {
    console.error(`❌ Refusing to run unsafe migration filename: ${migrationFile}`);
    process.exit(1);
  }
  if (!fs.existsSync(migrationPath)) {
    console.error(`❌ Migration file not found: ${migrationPath}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(migrationPath, 'utf8');

  console.log(`🚀 Applying migration: ${migrationFile}`);
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Split by semi-colon and execute individually if needed, but for simple scripts it's fine
    await client.query(sql);
    await client.query('COMMIT');
    console.log('✅ Migration applied successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error applying migration:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
