require('../../../backend/node_modules/dotenv').config({ path: require('path').resolve(__dirname, '../../../backend/.env') });
const { Client } = require('../../../backend/node_modules/pg');
(async () => {
  const c = new Client({ connectionString: process.env.DIRECT_DATABASE_URL });
  await c.connect();
  const r = await c.query("SELECT u.email, u.role FROM users u WHERE u.role = 'ADMIN' OR u.email ILIKE '%admin%' LIMIT 10");
  console.log(JSON.stringify(r.rows));
  const sponsors = await c.query("SELECT COUNT(*) FROM sponsors").catch(() => ({ rows: [{ count: 'ERR' }] }));
  console.log('sponsors:', sponsors.rows[0].count);
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });