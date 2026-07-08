import { createServer } from 'http';
import { Server } from 'socket.io';
import { createMatchWorker, createDispatchWorker } from './queue';
import { handleMatchRide } from './jobs/matchRide';
import { handleDispatchOffer } from './jobs/dispatchOffer';

async function main() {
  console.log('[WORKER] Starting match worker...');

  const httpServer = createServer();
  const io = new Server(httpServer);

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
