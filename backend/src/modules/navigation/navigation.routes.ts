// backend/src/modules/navigation/navigation.routes.ts
//
// Thin REST surface for the navigation subsystem. The hot path is
// socket-driven (see gateway/socket.gateway.ts `requestReroute` +
// `navigationRouteUpdated`); these endpoints back the Flutter
// driver's fallback HTTP calls when the socket isn't connected yet
// (cold start, after a reconnect, etc).

import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware';
import { NavigationService } from '../../services/navigation.service';
import { GeospatialService } from '../geospatial/geospatial.service';
import { pool } from '../../config/database';

const router = Router();

/**
 * POST /api/navigation/reroute
 * Body: { tripId, leg: 'pickup'|'destination', lat, lng }
 *
 * Mirrors the socket `requestReroute` handler. The driver app uses
 * the socket path during a live trip and falls back to this REST
 * endpoint if the socket has dropped mid-ride.
 */
router.post('/reroute', authMiddleware, async (req, res) => {
  try {
    const { tripId, leg, lat, lng } = req.body || {};
    if (!tripId || !leg || typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({
        error: 'tripId, leg, lat, lng required',
      });
    }
    if (leg !== 'pickup' && leg !== 'destination') {
      return res.status(400).json({ error: "leg must be 'pickup' or 'destination'" });
    }

    // Look up the leg endpoint from PG.
    const rideRes = await pool.query(
      'SELECT pickup_lat, pickup_lng, destination_lat, destination_lng FROM rides WHERE id = $1',
      [tripId]
    );
    const ride = rideRes.rows[0];
    if (!ride) return res.status(404).json({ error: 'Trip not found' });

    const end: [number, number] =
      leg === 'pickup'
        ? [ride.pickup_lat, ride.pickup_lng]
        : [ride.destination_lat, ride.destination_lng];

    // Re-route + refresh the Redis cache.
    const route = await NavigationService.cacheRouteLeg(
      tripId,
      leg,
      [lat, lng],
      end
    );

    // Persist on the ride metadata.
    await pool.query(
      `UPDATE rides SET route_metadata = route_metadata || $1::jsonb WHERE id = $2`,
      [JSON.stringify({ [leg]: route }), tripId]
    );

    res.json({ route });
  } catch (err: any) {
    console.error(`[NAV] /reroute failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to refresh route' });
  }
});

/**
 * GET /api/navigation/cached?tripId=...&leg=...
 * Returns the cached route leg if it exists, else { route: null }.
 */
router.get('/cached', authMiddleware, async (req, res) => {
  try {
    const tripId = req.query.tripId as string | undefined;
    const leg = req.query.leg as string | undefined;
    if (!tripId || !leg) {
      return res.status(400).json({ error: 'tripId + leg required' });
    }
    if (leg !== 'pickup' && leg !== 'destination') {
      return res.status(400).json({ error: "leg must be 'pickup' or 'destination'" });
    }

    const route = await NavigationService.getCachedRouteLeg(tripId, leg);
    res.json({ route });
  } catch (err: any) {
    console.error(`[NAV] /cached failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to read cached route' });
  }
});

export default router;