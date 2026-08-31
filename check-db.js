const { Pool } = require('pg');
const pool = new Pool({
  connection: 'postgresql://localhost/netride',
  // Host/port etc would be in the .env, let's just try connecting
});
pool.connect()
  .then(client => {
    return client.query('SELECT id, email, role, is_active, password_hash FROM users WHERE email = \$1', ['admin@netride.org'])
      .then(r => {
        console.log('Admin user found:', r.rows.length > 0);
        if (r.rows.length > 0) {
          const user = r.rows[0];
          console.log('Email:', user.email);
          console.log('Role:', user.role);
          console.log('Is active:', user.is_active);
          console.log('Has password hash:', !!user.password_hash);
          console.log('Password hash length:', user.password_hash ? user.password_hash.length : 0);
        }
        return client.query('SELECT count(*) FROM users');
      })
      .then(r => {
        console.log('Total users:', r.rows[0].count);
        return client.end();
      })
      .catch(e => console.error('Query error:', e.message))
      .finally(() => pool.end());
  })
  .catch(e => console.error('Connection error:', e.message));