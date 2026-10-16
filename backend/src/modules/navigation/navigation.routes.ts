// backend/src/modules/navigation/navigation.routes.ts
//
// Thin REST surface for the navigation subsystem. The hot path is
// socket-driven (see gateway/socket.gateway.ts `requestReroute` +
// `navigationRouteUpdated`); these endpoints back the Flutter
// driver's fallback HTTP calls when the socket isn't connected yet
// (cold start, after a reconnect, etc).

import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { NavigationService } from '../../services/navigation.service';
import { RerouteService } from '../../services/reroute.service';
import { pool } from '../../config/database';

const router = Router();

/**
 * Resource-level authorization: only the rider or the assigned driver of a
 * trip may read/refresh its route. Authentication alone (or knowledge of a
 * trip UUID) is never sufficient.
 */
async function isTripParty(tripId: string, userId: string): Promise<boolean> {
  const res = await pool.query(
    'SELECT 1 FROM rides WHERE id = $1 AND (rider_id = $2 OR driver_id = $2)',
    [tripId, userId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * POST /api/navigation/reroute
 * Body: { tripId, leg: 'pickup'|'destination', lat, lng }
 *
 * Mirrors the socket `requestReroute` handler. The driver app uses
 * the socket path during a live trip and falls back to this REST
 * endpoint if the socket has dropped mid-ride.
 *
 * The RerouteService decides between: stored ride leg → OD route cache
 * → Google Routes API (last resort).
 */
router.post('/reroute', authMiddleware, async (req: AuthRequest, res) => {
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

    // Only a party to the trip may refresh its route.
    if (!(await isTripParty(tripId, req.user!.id))) {
      return res.status(403).json({ error: 'You are not a party to this trip.' });
    }

    // Reroute through the decision ladder (stored leg → OD cache → Google).
    const route = await RerouteService.reroute(tripId, leg, lat, lng);

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
router.get('/cached', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const tripId = req.query.tripId as string | undefined;
    const leg = req.query.leg as string | undefined;
    if (!tripId || !leg) {
      return res.status(400).json({ error: 'tripId + leg required' });
    }
    if (leg !== 'pickup' && leg !== 'destination') {
      return res.status(400).json({ error: "leg must be 'pickup' or 'destination'" });
    }

    // Only a party to the trip may read its cached route.
    if (!(await isTripParty(tripId, req.user!.id))) {
      return res.status(403).json({ error: 'You are not a party to this trip.' });
    }

    const route = await NavigationService.getCachedRouteLeg(tripId, leg);
    res.json({ route });
  } catch (err: any) {
    console.error(`[NAV] /cached failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to read cached route' });
  }
});

export default router;