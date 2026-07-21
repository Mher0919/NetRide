// backend/src/health/health.controller.ts
//
// Two health endpoints for the load balancer:
//
//   GET /health/live   — process is up and the event loop is responsive.
//                        Cheap, never touches dependencies. Use this for
//                        "should I kill this instance?" decisions.
//
//   GET /health/ready  — process is ready to serve traffic. Pings every
//                        critical dependency (Redis, Postgres, ORS, Mapbox).
//                        Returns 503 with a JSON body listing what's
//                        down. Use this for "should I send this instance
//                        traffic?" decisions.

import { Request, Response, Router } from 'express';
import axios from 'axios';
import http from 'http';
import https from 'https';
import { redis } from '../config/redis';
import { pool } from '../config/database';
import { env } from '../config/env';
import { dependencyUp } from '../observability/metrics';
import { logger } from '../observability/logger';
import { matchQueue, dispatchQueue, cleanupQueue, scoreQueue } from '../queue/queue';
import { prisma } from '../services/prisma.service';
import { pubClient, subClient } from '../config/redisPubSub';

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

async function probeORS(): Promise<DependencyStatus> {
  const start = Date.now();
  try {
    const url = `https://api.openrouteservice.org/v2/directions/driving-car/geojson`;
    await axios.post(url, {
      coordinates: [[-118.4455, 34.0639], [-118.4400, 34.0700]],
      instructions: false,
      geometry: true,
    }, {
      params: { api_key: env.ORS_API_KEY },
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' },
    });
    dependencyUp.set({ dependency: 'routing-engine' }, 1);
    return { name: 'routing-engine', up: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    dependencyUp.set({ dependency: 'routing-engine' }, 0);
    return { name: 'routing-engine', up: false, error: err.message };
  }
}

async function probeMapbox(): Promise<DependencyStatus> {
  if (!env.MAPBOX_ACCESS_TOKEN) {
    return { name: 'routing-fallback', up: true };
  }
  const start = Date.now();
  try {
    const url = `https://api.mapbox.com/directions/v5/mapbox/${env.MAPBOX_PROFILE}/-118.4455,34.0639;-118.4400,34.0700`;
    await axios.get(url, {
      params: { access_token: env.MAPBOX_ACCESS_TOKEN, overview: 'simplified', steps: false },
      timeout: 5000,
    });
    return { name: 'routing-fallback', up: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    return { name: 'routing-fallback', up: false, error: err.message };
  }
}

async function probeRedisPubSub(): Promise<DependencyStatus> {
  const pubOk = pubClient.status === 'ready';
  const subOk = subClient.status === 'ready';
  return { name: 'redis-pubsub', up: pubOk && subOk };
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
    probeORS(),
    probeMapbox(),
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
