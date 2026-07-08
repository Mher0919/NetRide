import { Queue, Worker } from 'bullmq';
import { redis } from '../config/redis';
import { env } from '../config/env';

const connection = {
  host: new URL(env.REDIS_URL).hostname || '127.0.0.1',
  port: parseInt(new URL(env.REDIS_URL).port || '6379'),
};

export const matchQueue = new Queue('match-ride', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86400 },
  },
});

export const dispatchQueue = new Queue('match-dispatch', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 2000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86400 },
  },
});

export const scoreQueue = new Queue('score-driver-refresh', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 604800 },
  },
});

export const cleanupQueue = new Queue('cleanup-stale-rides', {
  connection,
  defaultJobOptions: {
    removeOnComplete: { age: 300 },
    removeOnFail: { age: 3600 },
  },
});

export async function createMatchWorker(handler: (job: any) => Promise<void>) {
  const worker = new Worker('match-ride', handler, {
    connection,
    concurrency: env.MATCH_WORKER_CONCURRENCY,
    stalledInterval: 30000,
    lockDuration: 60000,
  });
  worker.on('error', (err) => console.error('[QUEUE] match:ride worker error:', err.message));
  worker.on('completed', (job) => console.log(`[QUEUE] match:ride job ${job.id} completed`));
  worker.on('failed', (job, err) => console.error(`[QUEUE] match:ride job ${job?.id} failed:`, err.message));
  return worker;
}

export async function createDispatchWorker(handler: (job: any) => Promise<void>) {
  const worker = new Worker('match-dispatch', handler, {
    connection,
    concurrency: 4,
    stalledInterval: 30000,
    lockDuration: 30000,
  });
  worker.on('error', (err) => console.error('[QUEUE] match:dispatch worker error:', err.message));
  worker.on('completed', (job) => console.log(`[QUEUE] match:dispatch job ${job.id} completed`));
  worker.on('failed', (job, err) => console.error(`[QUEUE] match:dispatch job ${job?.id} failed:`, err.message));
  return worker;
}

export async function createScoreWorker(handler: (job: any) => Promise<void>) {
  const worker = new Worker('score-driver-refresh', handler, {
    connection,
    concurrency: 2,
    stalledInterval: 60000,
  });
  worker.on('error', (err) => console.error('[QUEUE] score:driver:refresh worker error:', err.message));
  return worker;
}

export async function createCleanupWorker(handler: (job: any) => Promise<void>) {
  const worker = new Worker('cleanup-stale-rides', handler, {
    connection,
    concurrency: 1,
    stalledInterval: 60000,
  });
  worker.on('error', (err) => console.error('[QUEUE] cleanup:stale-rides worker error:', err.message));
  return worker;
}

export async function scheduleRepeatableJobs() {
  await cleanupQueue.upsertJobScheduler('cleanup-stale-rides-every-5m', {
    pattern: '*/5 * * * *',
    tz: 'UTC',
  });

  await scoreQueue.upsertJobScheduler('score-refresh-every-5m', {
    pattern: '*/5 * * * *',
    tz: 'UTC',
  });
}
