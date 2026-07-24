// backend/src/routing/api/routing-api.ts
//
// REST API endpoints for the A* routing engine. Provides:
//   POST /api/routing/route   — Full route with geometry
//   POST /api/routing/distance — Distance + ETA only (lightweight)
//   POST /api/routing/snap    — Snap coordinate to nearest node
//   GET  /api/routing/stats   — Engine statistics and health

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { astarEngine } from '../engine/astar-engine';
import { logger } from '../../observability/logger';

const router = Router();

const CoordinateSchema = z.tuple([z.number(), z.number()]);
const RouteSchema = z.object({
  origin: CoordinateSchema,
  destination: CoordinateSchema,
});
const SnapSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});

/**
 * POST /api/routing/route
 * Full route: distance + duration + geometry + steps.
 */
router.post('/route', async (req: Request, res: Response) => {
  try {
    const parsed = RouteSchema.parse(req.body);
    const start = Date.now();

    const route = await astarEngine.route(parsed.origin, parsed.destination);

    if (!route) {
      res.status(404).json({ error: 'No route found', code: 'NO_ROUTE' });
      return;
    }

    const latencyMs = Date.now() - start;
    logger.debug({ latencyMs, distanceMeters: route.distanceMeters }, 'astar_api_route');

    res.json({
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      geometry: route.geometry,
      steps: route.steps,
      speedLimitsByRoad: route.speedLimitsByRoad,
      engine: 'A*',
      latencyMs,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', details: err.errors });
      return;
    }
    logger.error({ err: err.message }, 'astar_api_route_error');
    res.status(500).json({ error: 'Routing failed' });
  }
});

/**
 * POST /api/routing/distance
 * Lightweight distance + ETA only (no geometry).
 */
router.post('/distance', async (req: Request, res: Response) => {
  try {
    const parsed = RouteSchema.parse(req.body);
    const start = Date.now();

    const result = await astarEngine.distanceAndETA(parsed.origin, parsed.destination);

    if (!result) {
      res.status(404).json({ error: 'No route found', code: 'NO_ROUTE' });
      return;
    }

    const latencyMs = Date.now() - start;
    res.json({
      distanceMeters: result.distanceMeters,
      durationSeconds: result.durationSeconds,
      engine: 'A*',
      latencyMs,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', details: err.errors });
      return;
    }
    logger.error({ err: err.message }, 'astar_api_distance_error');
    res.status(500).json({ error: 'Distance calculation failed' });
  }
});

/**
 * POST /api/routing/snap
 * Snap a GPS coordinate to the nearest graph node.
 */
router.post('/snap', async (req: Request, res: Response) => {
  try {
    const parsed = SnapSchema.parse(req.body);
    const nodeIndex = astarEngine.snapNode(parsed.lat, parsed.lng);

    if (nodeIndex === null) {
      res.status(404).json({ error: 'No nearby node found', code: 'NO_NODE' });
      return;
    }

    const coords = astarEngine.getNodeCoords(nodeIndex);
    res.json({
      nodeIndex,
      lat: coords?.lat,
      lng: coords?.lng,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', details: err.errors });
      return;
    }
    logger.error({ err: err.message }, 'astar_api_snap_error');
    res.status(500).json({ error: 'Snap failed' });
  }
});

/**
 * GET /api/routing/stats
 * Engine statistics and health check.
 */
router.get('/stats', (_req: Request, res: Response) => {
  const stats = astarEngine.stats();
  res.json({
    ...stats,
    healthy: stats.loaded,
    uptime: process.uptime(),
  });
});

/**
 * POST /api/routing/cache/clear
 * Clear all routing caches.
 */
router.post('/cache/clear', (_req: Request, res: Response) => {
  astarEngine.clearCache();
  res.json({ success: true, message: 'Cache cleared' });
});

export default router;
