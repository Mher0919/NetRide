const Redis = require('ioredis');
(async () => {
  const r = new Redis('redis://127.0.0.1:6379');
  const keys = await r.keys('driver:offer:*');
  const rideKeys = await r.keys('ride:offer:*');
  const lockKeys = await r.keys('ride:lock:*');
  const all = [...keys, ...rideKeys, ...lockKeys];
  if (all.length > 0) await r.del(...all);
  console.log('cleared', keys.length, 'offer keys,', rideKeys.length, 'ride-offer keys,', lockKeys.length, 'locks');
  await r.quit();
})().catch((e) => { console.error(e.message); process.exit(1); });
