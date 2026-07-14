import { Router } from 'express';
import { AdminController } from './admin.controller';
import { authMiddleware, adminMiddleware } from '../../middleware/auth.middleware';

const router = Router();

// Protect all admin routes
router.use(authMiddleware);
router.use(adminMiddleware);

router.get('/stats', AdminController.getStats);
router.get('/users', AdminController.getUsers);
router.get('/users/:id', AdminController.getUserById);
router.get('/users/:id/speeding', AdminController.getDriverSpeeding);
router.patch('/users/:id/verify', AdminController.verifyUser);
router.patch('/users/:id/reject', AdminController.rejectUser);
router.patch('/users/:id/pending', AdminController.setPending);
router.patch('/users/:id/clear-dangerous', AdminController.clearDangerousFlag);
router.get('/rides', AdminController.getRides);
router.get('/rides/:id', AdminController.getRideById);
router.get('/rides/:id/audit', AdminController.getRideAudit);
router.get('/drivers/live', AdminController.getLiveDrivers);
router.get('/drivers/dangerous', AdminController.getDangerousDrivers);
router.get('/speeding/violations', AdminController.getSpeedingViolations);
router.patch('/vehicles/:vehicleId/inspection', AdminController.verifyInspection);
router.get('/logs', AdminController.getLogs);

// Profile-change approval queue
router.get('/profile-changes', AdminController.listProfileChanges);
router.get('/profile-changes/:id', AdminController.getProfileChange);
router.post('/profile-changes/:id/approve', AdminController.approveProfileChange);
router.post('/profile-changes/:id/reject', AdminController.rejectProfileChange);

// Payout cards
router.get('/payout-cards', AdminController.listPayoutCards);
router.post('/payout-cards/:id/approve', AdminController.approvePayoutCard);
router.post('/payout-cards/:id/reject', AdminController.rejectPayoutCard);

// Payouts
router.get('/payouts', AdminController.listPayouts);
router.post('/payouts/:id/mark-paid', AdminController.markPayoutPaid);

// Document resubmission requirements
router.post('/users/:id/request-docs', AdminController.requestDocumentResubmission);
router.get('/users/:id/document-requirements', AdminController.getDriverDocumentRequirements);
router.patch('/document-requirements/:id/review', AdminController.reviewDocumentRequirement);

// Vehicle submission review (025 / 026)
router.get('/vehicles/submissions', AdminController.listVehicleSubmissions);
router.get('/vehicles/submissions/:id', AdminController.getVehicleSubmission);
router.post('/vehicles/submissions/:id/approve', AdminController.approveVehicleSubmission);
router.post('/vehicles/submissions/:id/reject', AdminController.rejectVehicleSubmission);
router.post('/vehicles/submissions/:id/request-changes', AdminController.requestVehicleChanges);
router.post('/users/:id/request-vehicle-resubmission', AdminController.requestVehicleResubmission);

export default router;
