const Redis = require('ioredis');
const opts = {
  maxRetriesPerRequest: null,
  connectTimeout: 5000,
  enableOfflineQueue: true,
  lazyConnect: true,
  retryStrategy: (t) => (t > 10 ? null : Math.min(t * 200, 2000)),
};
(async () => {
  const pub = new Redis('redis://127.0.0.1:6379', opts);
  const sub = new Redis('redis://127.0.0.1:6379', opts);
  await Promise.all([pub.connect(), sub.connect()]);
  await sub.psubscribe('socket.io#*');
  console.log('sub status:', sub.status);
  const pubPong = await pub.ping();
  console.log('pub ping:', JSON.stringify(pubPong), typeof pubPong);
  try {
    const subPong = await sub.ping();
    console.log('sub ping:', JSON.stringify(subPong), typeof subPong);
  } catch (e) {
    console.log('sub ping ERROR:', e.message);
  }
  process.exit(0);
})().catch((e) => { console.error('crash', e.message); process.exit(1); });