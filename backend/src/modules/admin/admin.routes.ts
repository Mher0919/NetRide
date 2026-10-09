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
router.get('/users/:id/ride-preferences', AdminController.getDriverRidePreferences);
  router.get('/users/:id/speeding', AdminController.getDriverSpeeding);
  router.get('/users/:id/earnings', AdminController.getDriverEarnings);
router.patch('/users/:id/verify', AdminController.verifyUser);
router.patch('/users/:id/reject', AdminController.rejectUser);
router.patch('/users/:id/pending', AdminController.setPending);
router.patch('/users/:id/block', AdminController.blockUser);
router.patch('/users/:id/unblock', AdminController.unblockUser);
router.patch('/users/:id/clear-dangerous', AdminController.clearDangerousFlag);
router.patch('/users/:id/license', AdminController.updateLicense);
router.get('/rides', AdminController.getRides);
router.get('/rides/:id', AdminController.getRideById);
  router.get('/rides/:id/audit', AdminController.getRideAudit);
  router.get('/rides/:id/routes', AdminController.getRideRoutes);
  router.get('/rides/:id/ledger', AdminController.getRideLedger);
// Operator escape hatches for stuck rides: terminate / force-complete a
// ride whose lifecycle stalled (production requirement — stale rides must
// never be visible-but-impossible-to-resolve).
router.post('/rides/:id/cancel', AdminController.cancelRide);
router.post('/rides/:id/complete', AdminController.completeRide);
router.get('/ratings/flagged', AdminController.getFlaggedRatings);
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

// Admin image/document management
router.post('/users/:id/upload-document', AdminController.uploadUserDocument);
router.delete('/users/:id/document', AdminController.deleteUserDocument);

// Vehicle submission review (025 / 026)
router.get('/vehicles/submissions', AdminController.listVehicleSubmissions);
router.get('/vehicles/submissions/:id', AdminController.getVehicleSubmission);
router.post('/vehicles/submissions/:id/approve', AdminController.approveVehicleSubmission);
router.post('/vehicles/submissions/:id/reject', AdminController.rejectVehicleSubmission);
router.post('/vehicles/submissions/:id/request-changes', AdminController.requestVehicleChanges);
router.post('/users/:id/request-vehicle-resubmission', AdminController.requestVehicleResubmission);

// Fleet partner management + revenue split (041)
router.get('/fleets', AdminController.listFleets);
router.post('/fleets', AdminController.createFleet);
router.patch('/fleets/:id', AdminController.updateFleet);
router.delete('/fleets/:id', AdminController.deleteFleet);
router.patch('/drivers/:id/fleet', AdminController.assignDriverFleet);

// Pricing profiles + revenue visibility (041)
router.get('/pricing', AdminController.listPricingProfiles);
router.patch('/pricing/:code', AdminController.updatePricingProfile);
router.get('/revenue', AdminController.getRevenueOverview);
  router.get('/analytics', AdminController.getRevenueAnalytics);
  router.get('/regions', AdminController.listRegions);
  router.post('/regions', AdminController.upsertRegion);

// Ride reports (042)
router.get('/reports', AdminController.listReports);
router.post('/reports/:id/resolve', AdminController.resolveReport);

export default router;
