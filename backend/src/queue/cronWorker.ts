import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { pubClient, subClient } from '../config/redisPubSub';
import { createScoreWorker, createCleanupWorker, scheduleRepeatableJobs } from './queue';
import { handleScoreRefresh } from './jobs/scoreRefresh';
import { handleCleanupStaleRides } from './jobs/cleanupStaleRides';

async function main() {
  console.log('[CRON] Starting cron worker...');

  const httpServer = createServer();
  const io = new Server(httpServer);

  try {
    await pubClient.connect();
    await subClient.connect();
    io.adapter(createAdapter(pubClient, subClient));
    console.log('[CRON] Socket.IO Redis adapter connected');
  } catch (err: any) {
    console.error(`[CRON] ⚠️ Redis adapter failed (non-fatal): ${err.message}`);
  }

  const scoreWorker = await createScoreWorker(await handleScoreRefresh());
  const cleanupWorker = await createCleanupWorker(await handleCleanupStaleRides(io));

  await scheduleRepeatableJobs();

  console.log('[CRON] Cron worker is ready');

  const shutdown = async () => {
    console.log('[CRON] Shutting down gracefully...');
    await scoreWorker.close();
    await cleanupWorker.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[CRON] Fatal error:', err);
  process.exit(1);
});
