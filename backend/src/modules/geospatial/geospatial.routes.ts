import { Router } from 'express';
import { GeospatialService } from './geospatial.service';
import { authMiddleware } from '../../middleware/auth.middleware';

const router = Router();

/**
 * POST /api/geospatial/route
 * Body: { start: [lat, lng], end: [lat, lng] }
 */
router.post('/route', authMiddleware, async (req, res) => {
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

/**
 * GET /api/geospatial/search
 * Query: q, lat, lon
 */
router.get('/search', authMiddleware, async (req, res) => {
  try {
    const { q, lat, lon } = req.query;
    if (!q) {
      return res.status(400).json({ error: 'Search query (q) is required' });
    }

    const results = await GeospatialService.searchPlaces(
      q as string,
      lat ? parseFloat(lat as string) : undefined,
      lon ? parseFloat(lon as string) : undefined
    );
    res.json(results);
  } catch (err: any) {
    console.error('[GEOSPATIAL] Search Controller Error:', err.message);
    res.status(500).json({ error: 'Failed to search places' });
  }
});

export default router;
