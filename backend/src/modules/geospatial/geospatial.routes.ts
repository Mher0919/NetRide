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
 * GET /api/geospatial/autocomplete
 * Query: q (required, min 2 chars)
 *
 * Returns up to 5 destination suggestions based on common search patterns.
 * Matches are prefix-based: "star" → ["Starbucks"], "mcd" → ["McDonald's"].
 */
router.get('/autocomplete', authMiddleware, async (req, res) => {
  try {
    const q = (req.query.q as string || '').trim();
    if (q.length < GeospatialService.MIN_AUTOCOMPLETE_LEN) {
      return res.status(400).json({ error: 'Query (q) must be at least 2 characters' });
    }

    const lat = req.query.lat ? parseFloat(req.query.lat as string) : undefined;
    const lon = req.query.lon ? parseFloat(req.query.lon as string) : undefined;

    const suggestions = await GeospatialService.autocompleteSearch(q, lat, lon);
    res.json({ suggestions });
  } catch (err: any) {
    console.error('[GEOSPATIAL] Autocomplete Error:', err.message);
    res.status(500).json({ error: 'Failed to get suggestions' });
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
 * Query: zip (required)
 *
 * Geocodes the ZIP via Nominatim (cached in Redis), validates the
 * coordinates are within California, then searches for nearby vehicle
 * inspection stations using the Overpass API with progressive radius
 * expansion (5 → 10 → 25 → 50 km).
 */
router.get('/inspection-locations', authMiddleware, async (req, res) => {
  try {
    const rawZip = (req.query.zip as string ?? '').replace(/\s+/g, '');
    if (!rawZip) {
      return res.status(400).json({ error: 'ZIP code is required.' });
    }
    if (!/^\d{5}$/.test(rawZip)) {
      return res.status(400).json({ error: 'ZIP code must be exactly 5 digits.' });
    }

    const coords = await GeospatialService.geocodeZip(rawZip);
    if (!coords) {
      return res.status(404).json({
        error:
          'This ZIP code could not be found or is outside California. ' +
          'NetRide vehicle inspections are currently only available in California.',
        code: 'ZIP_NOT_IN_CALIFORNIA',
      });
    }

    const stations = await GeospatialService.findNearbyInspections(
      coords.lat,
      coords.lon,
    );

    res.json({
      zip: rawZip,
      lat: coords.lat,
      lon: coords.lon,
      stations,
      count: stations.length,
    });
  } catch (err: any) {
    console.error(
      '[GEOSPATIAL] Inspection locations Controller Error:',
      err.message,
    );
    res.status(500).json({ error: 'Failed to find inspection locations.' });
  }
});

export default router;
