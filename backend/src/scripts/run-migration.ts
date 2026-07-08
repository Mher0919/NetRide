import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function runMigration() {
  const migrationFile = process.argv[2] || '009_admin_and_audit_logs.sql';
  const migrationPath = path.join(__dirname, '../../migrations/', migrationFile);
  
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
