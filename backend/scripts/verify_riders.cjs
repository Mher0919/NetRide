const { Pool } = require('pg');
const pool = new Pool({connectionString: 'postgresql://ridehail:secret@localhost:5432/ridehail'});
pool.query("UPDATE users SET verification_status='VERIFIED', is_verified=true WHERE email LIKE 'loadtest.rider.%'")
  .then(r => { console.log('Updated', r.rowCount, 'riders'); pool.end(); })
  .catch(e => { console.error(e); pool.end(); });
