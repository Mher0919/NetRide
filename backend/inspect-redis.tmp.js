require('dotenv').config();
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { retryStrategy: () => null });
redis.on('error', (e) => { console.error('ERR', e.message); process.exit(1); });
(async () => {
  const keys = await redis.keys('*');
  const routeKeys = keys.filter((k) => k.startsWith('route:history:'));
  const searchKeys = keys.filter((k) => k.startsWith('search:history:'));
  console.log('total keys:', keys.length);
  console.log('route:history keys:', routeKeys.length);
  for (const k of routeKeys) {
    const ttl = await redis.ttl(k);
    const list = await redis.lrange(k, 0, -1);
    console.log(`  ${k} ttl=${ttl}s entries=${list.length}`);
    for (const e of list.slice(0, 5)) {
      try {
        const j = JSON.parse(e);
        console.log(`    - ${j.originName} → ${j.destName}`);
      } catch (_) { console.log('    - <unparseable>'); }
    }
  }
  console.log('search:history keys:', searchKeys.length);
  for (const k of searchKeys) {
    const ttl = await redis.ttl(k);
    const list = await redis.lrange(k, 0, -1);
    console.log(`  ${k} ttl=${ttl}s entries=${list.length}`);
    for (const e of list) {
      try {
        const j = JSON.parse(e);
        console.log(`    - ${j.displayName}`);
      } catch (_) { console.log('    - <unparseable>'); }
    }
  }
  await redis.quit();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
