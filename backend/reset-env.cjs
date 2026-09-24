// reset-env.cjs — deterministically reset ride/queue state before an E2E
// run: cancel all non-terminal rides, wipe BullMQ + offer + trip state, then
// WAIT for the abandoned retry chains (up to 6 retries x 30s) to drain so a
// fresh run never races a stale dispatch.
require('dotenv').config();
const { Client } = require('pg');
const Redis = require('ioredis');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = new Client({ connectionString: process.env.DIRECT_DATABASE_URL });
  await c.connect();
  const r = await c.query(
    `UPDATE rides SET status='CANCELLED', cancelled_at=COALESCE(cancelled_at,NOW())
     WHERE status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVING','IN_PROGRESS') RETURNING id`
  );
  const redemptions = await c.query(
    `UPDATE special_redemptions SET status='CANCELLED', cancelled_at=COALESCE(cancelled_at,NOW())
     WHERE status IN ('CREATED','RIDE_PENDING','WAITING_FOR_SPONSOR') RETURNING id`
  );
  await c.end();
  console.log(`cancelled ${r.rows.length} rides, ${redemptions.rows.length} redemptions`);

  const redis = new Redis(process.env.REDIS_URL.replace('localhost', '127.0.0.1'), { maxRetriesPerRequest: 3 });
  redis.on('error', () => {});
  const del = async (pattern) => {
    const keys = await redis.keys(pattern);
    if (keys.length) await redis.del(...keys);
    return keys.length;
  };
  await del('bull:*');
  await del('driver:offer:*');
  await del('driver:*:active_trip');
  await del('arrival:*');
  await del('trip_route:*');
  await redis.quit();
  console.log('queues + trip state wiped');

  // Drain: abandoned rides re-enqueue a retry every 30s (max 6). Wait it out
  // so the next run starts against an empty match-ride queue.
  console.log('draining stale retry chains (35s)...');
  await sleep(35000);
  const redis2 = new Redis(process.env.REDIS_URL.replace('localhost', '127.0.0.1'), { maxRetriesPerRequest: 3 });
  redis2.on('error', () => {});
  const remaining = await redis2.keys('bull:*');
  console.log('remaining queue keys after drain:', remaining.length);
  if (remaining.length) await redis2.del(...remaining);
  await redis2.quit();
  console.log('ENV RESET COMPLETE');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });