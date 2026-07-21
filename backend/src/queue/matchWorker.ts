import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { pubClient, subClient } from '../config/redisPubSub';
import { createMatchWorker, createDispatchWorker } from './queue';
import { handleMatchRide } from './jobs/matchRide';
import { handleDispatchOffer } from './jobs/dispatchOffer';

async function main() {
  console.log('[WORKER] Starting match worker...');

  const httpServer = createServer();
  const io = new Server(httpServer);

  // Share the same Redis pub/sub channel as the main app so emits
  // (io.to('driver:xxx').emit(...)) reach clients connected to the main server.
  try {
    await pubClient.connect();
    await subClient.connect();
    io.adapter(createAdapter(pubClient, subClient));
    console.log('[WORKER] Socket.IO Redis adapter connected');
  } catch (err: any) {
    console.error(`[WORKER] ⚠️ Redis adapter failed (non-fatal): ${err.message}`);
  }

  const matchWorker = await createMatchWorker(await handleMatchRide(io));
  const dispatchWorker = await createDispatchWorker(await handleDispatchOffer(io));

  console.log('[WORKER] Match worker is ready');

  const shutdown = async () => {
    console.log('[WORKER] Shutting down gracefully...');
    await matchWorker.close();
    await dispatchWorker.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[WORKER] Fatal error:', err);
  process.exit(1);
});
