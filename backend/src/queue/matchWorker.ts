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
  // NOTE: do NOT call pubClient.connect()/subClient.connect() here —
  // redisPubSub.ts already opens both connections at module load. A second
  // explicit connect() throws ("Redis is already connecting/connected"),
  // which silently leaves the worker's Socket.IO on the default in-memory
  // adapter — every worker emit (newTripRequest offers, ride cancellations)
  // is then dropped instead of reaching clients on the API server.
  try {
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
