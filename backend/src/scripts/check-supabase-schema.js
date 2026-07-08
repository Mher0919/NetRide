const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function checkSchema() {
  try {
    const tableRes = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    const tables = tableRes.rows.map(r => r.table_name);
    
    const enumRes = await pool.query("SELECT t.typname FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid GROUP BY t.typname");
    const enums = enumRes.rows.map(r => r.typname);

    console.log('--- Database Schema Check ---');
    console.log('Tables found:', tables.join(', '));
    console.log('Enums found:', enums.join(', '));
    
    const hasAdmin = await pool.query("SELECT enumlabel FROM pg_enum WHERE enumtypid = 'user_role'::regtype AND enumlabel = 'ADMIN'");
    console.log('ADMIN role in user_role:', hasAdmin.rowCount > 0);

  } catch (err) {
    console.error('Error checking schema:', err.message);
  } finally {
    await pool.end();
  }
}

checkSchema();
