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

/**
 * GET /api/geospatial/inspection-locations
 * Query: zip (required), lat (optional), lon (optional)
 * Returns nearby vehicle inspection stations.
 */
router.get('/inspection-locations', authMiddleware, async (req, res) => {
  try {
    let { zip, lat, lon } = req.query;
    if (!zip) {
      return res.status(400).json({ error: 'ZIP code (zip) is required' });
    }

    // If lat/lon not provided, try to geocode the ZIP first
    if (!lat || !lon) {
      const geoRes = await GeospatialService.searchPlaces(`${zip}, California`, undefined, undefined);
      if (geoRes.length > 0) {
        lat = String(geoRes[0].lat);
        lon = String(geoRes[0].lon);
      }
    }

    const query = 'vehicle inspection station smog check auto repair';
    const results = await GeospatialService.searchPlaces(
      query,
      lat ? parseFloat(lat as string) : undefined,
      lon ? parseFloat(lon as string) : undefined
    );

    res.json(results);
  } catch (err: any) {
    console.error('[GEOSPATIAL] Inspection locations Controller Error:', err.message);
    res.status(500).json({ error: 'Failed to find inspection locations' });
  }
});

export default router;
