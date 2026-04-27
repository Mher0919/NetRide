// backend/src/modules/driver/driver.routes.ts
import { Router } from 'express';
import { DriverController } from './driver.controller';
import { authMiddleware } from '../../middleware/auth.middleware';

const router = Router();

router.get('/profile', authMiddleware, DriverController.getProfile);
router.patch('/profile', authMiddleware, DriverController.updateProfile);
router.post('/verify-identity', authMiddleware, DriverController.verifyIdentity);
router.post('/onboard', authMiddleware, DriverController.onboard);
router.get('/vehicles', DriverController.getVehicles);

export default router;
