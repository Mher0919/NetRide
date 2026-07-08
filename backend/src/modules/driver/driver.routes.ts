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
router.patch('/operating-class', authMiddleware, DriverController.updateOperatingClass);
router.get('/pricing', authMiddleware, DriverController.getPricing);
router.post('/pricing/update', authMiddleware, DriverController.updatePrice);
router.get('/recommendations', authMiddleware, DriverController.getRecommendations);

// Vehicle Model Search
router.get('/vehicle-models/search', DriverController.searchVehicleModels);
router.get('/vehicle-models/years', DriverController.getVehicleYears);
router.get('/vehicle-models/makes', DriverController.getVehicleMakes);
router.get('/vehicle-models/models', DriverController.getVehicleModelsByMake);

// Profile-change approval queue
router.post('/profile-changes', authMiddleware, DriverController.submitProfileChange);
router.get('/profile-changes/current', authMiddleware, DriverController.getCurrentProfileChange);

// Wallet + payouts
router.post('/payout-cards', authMiddleware, DriverController.addPayoutCard);
router.get('/wallet', authMiddleware, DriverController.getWallet);
router.post('/wallet/request-payout', authMiddleware, DriverController.requestOnDemandPayout);
router.get('/payouts', authMiddleware, DriverController.listMyPayouts);

export default router;
