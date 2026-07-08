const { Pool } = require('pg');
require('dotenv').config();
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function verifyUser() {
  try {
    const res = await pool.query("SELECT email, role, password_hash, is_verified FROM users WHERE email = $1", ['admin@netride.com']);
    
    if (res.rows.length === 0) {
      console.log('❌ User admin@netride.com NOT FOUND in database.');
      return;
    }

    const user = res.rows[0];
    console.log('✅ User found:', {
      email: user.email,
      role: user.role,
      hasPassword: !!user.password_hash,
      isVerified: user.is_verified
    });

    if (user.password_hash) {
      const isMatch = await bcrypt.compare('AdminPassword123!', user.password_hash);
      console.log('🔑 Password match (AdminPassword123!):', isMatch);
    } else {
      console.log('⚠️ Password hash is null/empty.');
    }

  } catch (err) {
    console.error('Error verifying user:', err.message);
  } finally {
    await pool.end();
  }
}

verifyUser();
