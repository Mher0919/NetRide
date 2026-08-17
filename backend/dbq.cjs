require('dotenv').config();
const { Client } = require('pg');
const q = process.argv[2];
(async () => {
  const c = new Client({ connectionString: process.env.DIRECT_DATABASE_URL });
  await c.connect();
  const r = await c.query(q);
  console.log(JSON.stringify(r.rows, null, 1));
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
