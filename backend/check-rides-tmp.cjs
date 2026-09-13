require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DIRECT_DATABASE_URL });
  await c.connect();
  const r = await c.query(
    `SELECT id, status, driver_id, started_at, completed_at, cancelled_at
     FROM rides WHERE id IN ('e32a69dd-913a-45d7-a607-e07282fcf3f9','9ccc119f-6ef7-4391-b39f-9b40a8808166')
     ORDER BY created_at DESC`
  );
  console.log(JSON.stringify(r.rows, null, 1));
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });