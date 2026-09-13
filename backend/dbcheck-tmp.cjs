require('dotenv').config();
const { Client } = require('pg');
const urls = {
  pooler6543: process.env.DATABASE_URL,
  direct5432: process.env.DIRECT_DATABASE_URL,
  direct5432_sslmode: process.env.DIRECT_DATABASE_URL + '?sslmode=require',
};
(async () => {
  for (const [name, url] of Object.entries(urls)) {
    const t = Date.now();
    try {
      const c = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
      await c.connect();
      const r = await c.query('SELECT 1');
      await c.end();
      console.log(name, 'OK', Date.now() - t + 'ms');
    } catch (e) {
      console.log(name, 'FAIL', Date.now() - t + 'ms:', e.message);
    }
  }
  process.exit(0);
})();