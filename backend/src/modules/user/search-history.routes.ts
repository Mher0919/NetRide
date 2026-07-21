import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware';
import { redis } from '../../config/redis';

const router = Router();

const MAX_HISTORY = 5;
const HISTORY_KEY_PREFIX = 'search:history:';
const HISTORY_TTL = 60 * 60 * 24 * 90; // 90 days

interface SearchHistoryEntry {
  displayName: string;
  lat: number;
  lon: number;
  state: string;
  type: string;
  savedAt: number;
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
        return JSON.parse(item) as SearchHistoryEntry;
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
 * Body: { displayName, lat, lon, state, type }
 * Saves a search to the user's history (max 5, deduped by coordinates).
 */
router.post('/search-history', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { displayName, lat, lon, state, type } = req.body;
    if (!displayName || lat == null || lon == null) {
      return res.status(400).json({ error: 'displayName, lat, lon are required' });
    }

    const entry: SearchHistoryEntry = {
      displayName: String(displayName).slice(0, 200),
      lat: Number(lat),
      lon: Number(lon),
      state: String(state || 'CA'),
      type: String(type || 'poi'),
      savedAt: Date.now(),
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

export default router;
