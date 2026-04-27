// backend/src/modules/ride/ride.routes.ts
import { Router } from 'express';
import { RideController } from './ride.controller';
import { authMiddleware } from '../../middleware/auth.middleware';

const router = Router();

router.post('/request', authMiddleware, RideController.requestRide);
router.post('/accept', authMiddleware, RideController.acceptTrip);
router.post('/rate', authMiddleware, RideController.rateRide);
router.get('/history', authMiddleware, RideController.getHistory);

export default router;
