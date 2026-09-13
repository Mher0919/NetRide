// backend/src/health/health.controller.ts
//
// Two health endpoints for the load balancer:
//
//   GET /health/live   — process is up and the event loop is responsive.
//                        Cheap, never touches dependencies. Use this for
//                        "should I kill this instance?" decisions.
//
//   GET /health/ready  — process is ready to serve traffic. Pings every
//                        critical dependency (Redis, Postgres, Google Routes).
//                        Returns 503 with a JSON body listing what's
//                        down. Use this for "should I send this instance
//                        traffic?" decisions.

import { Request, Response, Router } from 'express';
import { redis } from '../config/redis';
import { pool } from '../config/database';
import { env } from '../config/env';
import { dependencyUp } from '../observability/metrics';
import { logger } from '../observability/logger';
import { matchQueue, dispatchQueue, cleanupQueue, scoreQueue } from '../queue/queue';
import { prisma } from '../services/prisma.service';
import { pubClient, subClient } from '../config/redisPubSub';
import { GoogleRoutesEngine } from '../modules/routing/google-routes.engine';

const router = Router();

// Cheap self check — just confirm the event loop is responding.
router.get('/health/live', (_req: Request, res: Response) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

interface DependencyStatus {
  name: string;
  up: boolean;
  latencyMs?: number;
  error?: string;
  detail?: string;
}

async function probeRedis(): Promise<DependencyStatus> {
  const start = Date.now();
  try {
    const pong = await redis.ping();
    const up = pong === 'PONG';
    dependencyUp.set({ dependency: 'redis' }, up ? 1 : 0);
    return { name: 'redis', up, latencyMs: Date.now() - start };
  } catch (err: any) {
    dependencyUp.set({ dependency: 'redis' }, 0);
    return { name: 'redis', up: false, error: err.message };
  }
}

async function probePostgres(): Promise<DependencyStatus> {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    dependencyUp.set({ dependency: 'postgres' }, 1);
    return { name: 'postgres', up: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    dependencyUp.set({ dependency: 'postgres' }, 0);
    return { name: 'postgres', up: false, error: err.message };
  }
}

async function probeRoutingEngine(): Promise<DependencyStatus> {
  const start = Date.now();
  try {
    // Google Routes is the SOLE routing engine (ORS/OSRM/A* were removed).
    // Probe it with a short real route so the readiness signal reflects the
    // engine that actually serves ride requests.
    const route = await GoogleRoutesEngine.route([34.0639, -118.4455], [34.0700, -118.4400]);
    const up = route !== null;
    dependencyUp.set({ dependency: 'routing-engine' }, up ? 1 : 0);
    return { name: 'routing-engine', up, latencyMs: Date.now() - start };
  } catch (err: any) {
    dependencyUp.set({ dependency: 'routing-engine' }, 0);
    return { name: 'routing-engine', up: false, error: err.message };
  }
}

async function probeAStarEngine(): Promise<DependencyStatus> {
  const start = Date.now();
  try {
    const { astarEngine } = await import('../routing/engine/astar-engine');
    if (!astarEngine.isReady()) {
      return { name: 'astar-engine', up: true, latencyMs: Date.now() - start, detail: 'not-loaded' };
    }
    const stats = astarEngine.stats();
    return {
      name: 'astar-engine',
      up: true,
      latencyMs: Date.now() - start,
      detail: `${stats.nodes} nodes, ${stats.edges} edges`,
    };
  } catch (err: any) {
    return { name: 'astar-engine', up: false, error: err.message };
  }
}

async function probeRedisPubSub(): Promise<DependencyStatus> {
  const start = Date.now();
  try {
    // Pub/sub clients use lazyConnect — `.status` stays 'wait' until the
    // first command triggers a connection, so a passive status check would
    // report "down" even when Redis is healthy. Actively ping instead.
    // NOTE: the subClient is in subscriber mode (psubscribed by the Socket.IO
    // adapter), where ioredis returns an array like ["pong", ""] — a
    // successful response either way proves the connection is alive.
    const [pubPong, subPong] = await Promise.all([
      pubClient.ping(),
      subClient.ping().catch(() => null),
    ]);
    const up = pubPong === 'PONG' && subPong !== null;
    return { name: 'redis-pubsub', up, latencyMs: Date.now() - start };
  } catch (err: any) {
    return { name: 'redis-pubsub', up: false, error: err.message };
  }
}

async function probePostgresReplica(): Promise<DependencyStatus> {
  if (!env.DATABASE_REPLICA_URL) {
    return { name: 'postgres-replica', up: true };
  }
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { name: 'postgres-replica', up: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    return { name: 'postgres-replica', up: false, error: err.message };
  }
}

async function probeQueue(name: string, queue: { getJobCounts: () => Promise<any> }): Promise<DependencyStatus> {
  const start = Date.now();
  try {
    const counts = await queue.getJobCounts();
    const depth = (counts.waiting || 0) + (counts.active || 0);
    const up = depth < 10000;
    return { name: `queue:${name}`, up, latencyMs: Date.now() - start };
  } catch (err: any) {
    return { name: `queue:${name}`, up: false, error: err.message };
  }
}

router.get('/health/ready', async (_req: Request, res: Response) => {
  const results = await Promise.all([
    probeRedis(),
    probeRedisPubSub(),
    probePostgres(),
    probePostgresReplica(),
    probeRoutingEngine(),
    probeAStarEngine(),
    probeQueue('match:ride', matchQueue),
    probeQueue('match:dispatch', dispatchQueue),
    probeQueue('score:driver:refresh', scoreQueue),
    probeQueue('cleanup:stale-rides', cleanupQueue),
  ]);
  const allUp = results.every((r) => r.up);
  if (!allUp) {
    logger.warn({ results }, 'health_ready degraded');
  }
  res.status(allUp ? 200 : 503).json({
    status: allUp ? 'ok' : 'degraded',
    checks: results,
  });
});

export default router;
