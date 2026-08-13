// backend/src/modules/heatmap/heatmap.routes.ts
//
// DEMAND HEATMAP API — driver app consumes aggregated zones only.
// ---------------------------------------------------------------------------
// GET /api/heatmap?lat=<>&lng=<>&radiusKm=<>
//
// Returns the top demand zones around the driver, computed from REAL rider
// activity in the last DEMAND_WINDOW_MINUTES with time decay. The response
// contains zone geometry only (center, radius, relative score) — never raw
// rider positions, counts are stripped, and the payload is cached server-side.
//
// Auth: any verified driver (or admin) with a valid JWT.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, driverMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { getDemandZones } from '../../services/demand.service';

const router = Router();

const heatmapQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().min(3).max(25).optional(),
});

router.get('/', authMiddleware, driverMiddleware, async (req: AuthRequest, res: Response) => {
  const parsed = heatmapQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid location', details: parsed.error.format() });
  }

  try {
    const { lat, lng, radiusKm } = parsed.data;
    const result = await getDemandZones(lat, lng, radiusKm ?? 10);
    if (!result) {
      return res.status(422).json({ error: 'Unable to compute demand zones' });
    }
    return res.json(result);
  } catch (err: any) {
    console.error('[HEATMAP] Failed to build heatmap:', err.message);
    return res.status(500).json({ error: 'Failed to load demand heatmap' });
  }
});

export default router;