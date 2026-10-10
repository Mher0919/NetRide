// backend/src/modules/driver/driver.routes.ts
import { Router } from 'express';
import { DriverController } from './driver.controller';
import { authMiddleware } from '../../middleware/auth.middleware';

const router = Router();

router.get('/profile', authMiddleware, DriverController.getProfile);
router.patch('/profile', authMiddleware, DriverController.updateProfile);
router.post('/verify-identity', authMiddleware, DriverController.verifyIdentity);
router.get('/onboarding/progress', authMiddleware, DriverController.getOnboardingProgress);
router.post('/onboarding/step', authMiddleware, DriverController.saveOnboardingStep);
router.post('/onboarding/complete', authMiddleware, DriverController.completeOnboarding);
router.post('/onboard', authMiddleware, DriverController.onboard);
router.get('/vehicles', DriverController.getVehicles);

// Vehicle Model Search
router.get('/vehicle-models/search', DriverController.searchVehicleModels);
router.get('/vehicle-models/years', DriverController.getVehicleYears);
router.get('/vehicle-models/makes', DriverController.getVehicleMakes);
router.get('/vehicle-models/models', DriverController.getVehicleModelsByMake);

// Profile-change approval queue
router.post('/profile-changes', authMiddleware, DriverController.submitProfileChange);
router.get('/profile-changes/current', authMiddleware, DriverController.getCurrentProfileChange);

// Wallet + payouts
router.get('/wallet', authMiddleware, DriverController.getWallet);
router.post('/wallet/request-payout', authMiddleware, DriverController.requestOnDemandPayout);
router.get('/payouts', authMiddleware, DriverController.listMyPayouts);

// Document requirements + resubmission
router.get('/documents/requirements', authMiddleware, DriverController.getDocumentRequirements);
router.post('/documents/resubmit', authMiddleware, DriverController.resubmitDocument);
router.post('/documents/batch-resubmit', authMiddleware, DriverController.batchResubmitDocuments);

// New vehicle submission (025)
router.post('/vehicles/submit', authMiddleware, DriverController.submitNewVehicle);
router.get('/vehicles/submissions/pending', authMiddleware, DriverController.getPendingVehicleSubmissions);

// Vehicle resubmission requirements (026)
router.get('/vehicles/resubmission-requirements', authMiddleware, DriverController.getVehicleResubmissionRequirements);
router.post('/vehicles/submit-resubmission', authMiddleware, DriverController.submitVehicleResubmission);

export default router;
