// backend/src/modules/routing/routing.routes.ts
import { Router } from 'express';
import { RoutingController } from './routing.controller';
import { rateLimitMiddleware } from '../../middleware/rateLimit.middleware';

const router = Router();

/**
 * POST /api/routing/plan
 * Body: { origin: [lat, lng], destination: [lat, lng], vehicleClass?: 'CORE'|'ELITE'|'PRESTIGE' }
 *
 * Returns route geometry, ETA, and a full fare breakdown in a single request.
 * This is the only endpoint the rider app's planning flow should call.
 */
router.post('/plan', rateLimitMiddleware, RoutingController.plan);
router.post('/google-plan', rateLimitMiddleware, RoutingController.googlePlan);

export default router;
