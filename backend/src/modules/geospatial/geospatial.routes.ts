import { Router } from 'express';
import { GeospatialService } from './geospatial.service';

const router = Router();

/**
 * POST /api/geospatial/route
 * Body: { start: [lat, lng], end: [lat, lng] }
 */
router.post('/route', async (req, res) => {
  try {
    const { start, end } = req.body;
    
    if (!start || !end || !Array.isArray(start) || !Array.isArray(end) || start.length !== 2 || end.length !== 2) {
      return res.status(400).json({ error: 'Start and end coordinates are required as [lat, lng] tuples' });
    }

    const route = await GeospatialService.getRoute(start as [number, number], end as [number, number]);
    res.json(route);
  } catch (err: any) {
    console.error('[GEOSPATIAL] Controller Error:', err.message);
    res.status(500).json({ error: 'Failed to calculate route' });
  }
});

export default router;
