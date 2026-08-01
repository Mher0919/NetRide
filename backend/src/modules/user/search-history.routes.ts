import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware';
import { redis } from '../../config/redis';

const router = Router();

const MAX_HISTORY = 5;
const HISTORY_KEY_PREFIX = 'search:history:';
const HISTORY_TTL = 60 * 60 * 24 * 90; // 90 days

interface SearchHistoryEntry {
  displayName: string;
  address?: string;
  distance?: string;
  lat: number;
  lon: number;
  state: string;
  type: string;
  savedAt: number;
  formatted_address?: string;
  street?: string;
  city?: string;
  zip?: string;
  category?: string;
  subcategory?: string;
}

/**
 * GET /api/user/search-history
 * Returns the user's latest 5 searches (most recent first).
 */
router.get('/search-history', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const key = `${HISTORY_KEY_PREFIX}${userId}`;
    const raw = await redis.lrange(key, 0, MAX_HISTORY - 1);

    const history = raw.map((item) => {
      try {
        const parsed = JSON.parse(item) as SearchHistoryEntry & Record<string, any>;
        // Normalize camelCase storage keys to snake_case for Flutter compatibility
        return {
          display_name: parsed.displayName,
          lat: parsed.lat,
          lon: parsed.lon,
          state: parsed.state,
          type: parsed.type,
          distance_miles: parsed.distance ? parseFloat(parsed.distance) : undefined,
          is_suggestion: false,
          formatted_address: parsed.formatted_address || parsed.address,
          street: parsed.street,
          city: parsed.city,
          zip: parsed.zip,
          category: parsed.category,
          subcategory: parsed.subcategory,
        };
      } catch {
        return null;
      }
    }).filter(Boolean);

    res.json(history);
  } catch (err: any) {
    console.error('[SEARCH_HISTORY] GET error:', err.message);
    res.json([]);
  }
});

/**
 * POST /api/user/search-history
 * Body: { displayName, lat, lon, state, type, address?, distance? }
 * Saves a search to the user's history (max 5, deduped by coordinates).
 */
router.post('/search-history', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { displayName, lat, lon, state, type, address, distance, formatted_address, street, city, zip, category, subcategory } = req.body;
    if (!displayName || lat == null || lon == null) {
      return res.status(400).json({ error: 'displayName, lat, lon are required' });
    }

    const entry: SearchHistoryEntry = {
      displayName: String(displayName).slice(0, 200),
      address: address ? String(address).slice(0, 300) : undefined,
      distance: distance ? String(distance).slice(0, 50) : undefined,
      lat: Number(lat),
      lon: Number(lon),
      state: String(state || 'CA'),
      type: String(type || 'poi'),
      savedAt: Date.now(),
      formatted_address: formatted_address ? String(formatted_address).slice(0, 300) : undefined,
      street: street ? String(street).slice(0, 200) : undefined,
      city: city ? String(city).slice(0, 100) : undefined,
      zip: zip ? String(zip).slice(0, 20) : undefined,
      category: category ? String(category).slice(0, 50) : undefined,
      subcategory: subcategory ? String(subcategory).slice(0, 50) : undefined,
    };

    const key = `${HISTORY_KEY_PREFIX}${userId}`;
    const serialized = JSON.stringify(entry);

    // Remove any existing entry with the same coordinates (dedup)
    const existing = await redis.lrange(key, 0, -1);
    for (const raw of existing) {
      try {
        const parsed = JSON.parse(raw) as SearchHistoryEntry;
        if (Math.abs(parsed.lat - entry.lat) < 0.0001 && Math.abs(parsed.lon - entry.lon) < 0.0001) {
          await redis.lrem(key, 1, raw);
        }
      } catch { /* skip corrupt entries */ }
    }

    // Push new entry to the front
    await redis.lpush(key, serialized);

    // Trim to max size
    await redis.ltrim(key, 0, MAX_HISTORY - 1);

    // Set expiry
    await redis.expire(key, HISTORY_TTL);

    res.json({ ok: true });
  } catch (err: any) {
    console.error('[SEARCH_HISTORY] POST error:', err.message);
    res.status(500).json({ error: 'Failed to save search history' });
  }
});

/**
 * DELETE /api/user/search-history
 * Clears the user's entire search history.
 */
router.delete('/search-history', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const key = `${HISTORY_KEY_PREFIX}${userId}`;
    await redis.del(key);

    res.json({ ok: true });
  } catch (err: any) {
    console.error('[SEARCH_HISTORY] DELETE error:', err.message);
    res.status(500).json({ error: 'Failed to clear search history' });
  }
});

const ROUTE_HISTORY_KEY_PREFIX = 'route:history:';
const MAX_ROUTE_HISTORY = 20;
const ROUTE_HISTORY_TTL = 60 * 60 * 24 * 30; // 30 days

interface RouteHistoryEntry {
  originLat: number;
  originLon: number;
  destLat: number;
  destLon: number;
  originName: string;
  destName: string;
  distanceMeters: number;
  durationSeconds: number;
  trafficDurationSeconds?: number;
  polyline: number[][];
  savedAt: number;
  vehicleClass: string;
}

/**
 * GET /api/user/search-history/routes
 * Returns the user's saved route history for cached routing.
 */
router.get('/search-history/routes', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const key = `${ROUTE_HISTORY_KEY_PREFIX}${userId}`;
    const raw = await redis.lrange(key, 0, MAX_ROUTE_HISTORY - 1);

    const history = raw.map((item) => {
      try {
        return JSON.parse(item) as RouteHistoryEntry;
      } catch {
        return null;
      }
    }).filter(Boolean);

    res.json(history);
  } catch (err: any) {
    console.error('[ROUTE_HISTORY] GET error:', err.message);
    res.json([]);
  }
});

/**
 * POST /api/user/search-history/routes
 * Body: { originLat, originLon, destLat, destLon, originName, destName, distanceMeters, durationSeconds, trafficDurationSeconds?, polyline, vehicleClass? }
 * Saves a route to user's history for caching. `vehicleClass` is optional
 * (NetRide operates a single Standard Ride; retained for legacy payloads).
 */
router.post('/search-history/routes', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { originLat, originLon, destLat, destLon, originName, destName, distanceMeters, durationSeconds, trafficDurationSeconds, polyline, vehicleClass } = req.body;
    
    if (originLat == null || originLon == null || destLat == null || destLon == null || !originName || !destName || distanceMeters == null || durationSeconds == null || !polyline) {
      return res.status(400).json({ error: 'Missing required route fields' });
    }

    const entry: RouteHistoryEntry = {
      originLat: Number(originLat),
      originLon: Number(originLon),
      destLat: Number(destLat),
      destLon: Number(destLon),
      originName: String(originName).slice(0, 200),
      destName: String(destName).slice(0, 200),
      distanceMeters: Number(distanceMeters),
      durationSeconds: Number(durationSeconds),
      trafficDurationSeconds: trafficDurationSeconds ? Number(trafficDurationSeconds) : undefined,
      polyline: polyline as number[][],
      savedAt: Date.now(),
      vehicleClass: vehicleClass ? String(vehicleClass) : 'CORE',
    };

    const key = `${ROUTE_HISTORY_KEY_PREFIX}${userId}`;
    const serialized = JSON.stringify(entry);

    // Remove any existing entry with same origin/dest/vehicleClass (dedup)
    const existing = await redis.lrange(key, 0, -1);
    for (const raw of existing) {
      try {
        const parsed = JSON.parse(raw) as RouteHistoryEntry;
        if (Math.abs(parsed.originLat - entry.originLat) < 0.0001 && 
            Math.abs(parsed.originLon - entry.originLon) < 0.0001 &&
            Math.abs(parsed.destLat - entry.destLat) < 0.0001 &&
            Math.abs(parsed.destLon - entry.destLon) < 0.0001 &&
            parsed.vehicleClass === entry.vehicleClass) {
          await redis.lrem(key, 1, raw);
        }
      } catch { /* skip corrupt entries */ }
    }

    // Push new entry to the front
    await redis.lpush(key, serialized);

    // Trim to max size
    await redis.ltrim(key, 0, MAX_ROUTE_HISTORY - 1);

    // Set expiry
    await redis.expire(key, ROUTE_HISTORY_TTL);

    res.json({ ok: true });
  } catch (err: any) {
    console.error('[ROUTE_HISTORY] POST error:', err.message);
    res.status(500).json({ error: 'Failed to save route history' });
  }
});

export default router;