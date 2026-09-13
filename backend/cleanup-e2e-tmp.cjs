require('dotenv').config();
const { Client } = require('pg');
const Redis = require('ioredis');
(async () => {
  const c = new Client({ connectionString: process.env.DIRECT_DATABASE_URL });
  await c.connect();
  await c.query(`UPDATE rides SET status='CANCELLED', cancelled_at=NOW(), cancelled_by=NULL
                 WHERE id IN ('e32a69dd-913a-45d7-a607-e07282fcf3f9','9ccc119f-6ef7-4391-b39f-9b40a8808166')
                   AND status IN ('REQUESTED','ACCEPTED','IN_PROGRESS')`);
  console.log('rides cleaned');
  await c.end();

  const r = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  const keys = await r.keys('driver:*');
  const offers = await r.keys('offer:*');
  const winners = await r.keys('dispatch:winners:*');
  const toDel = [...keys, ...offers, ...winners];
  if (toDel.length) await r.del(...toDel);
  console.log('redis keys deleted:', toDel.length);
  await r.quit();
})().catch((e) => { console.error(e.message); process.exit(1); });