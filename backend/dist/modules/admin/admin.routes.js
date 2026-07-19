"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const admin_controller_1 = require("./admin.controller");
const auth_middleware_1 = require("../../middleware/auth.middleware");
const router = (0, express_1.Router)();
// Protect all admin routes
router.use(auth_middleware_1.authMiddleware);
router.use(auth_middleware_1.adminMiddleware);
router.get('/stats', admin_controller_1.AdminController.getStats);
router.get('/users', admin_controller_1.AdminController.getUsers);
router.get('/users/:id', admin_controller_1.AdminController.getUserById);
router.get('/users/:id/speeding', admin_controller_1.AdminController.getDriverSpeeding);
router.patch('/users/:id/verify', admin_controller_1.AdminController.verifyUser);
router.patch('/users/:id/reject', admin_controller_1.AdminController.rejectUser);
router.patch('/users/:id/pending', admin_controller_1.AdminController.setPending);
router.patch('/users/:id/clear-dangerous', admin_controller_1.AdminController.clearDangerousFlag);
router.patch('/users/:id/license', admin_controller_1.AdminController.updateLicense);
router.get('/rides', admin_controller_1.AdminController.getRides);
router.get('/rides/:id', admin_controller_1.AdminController.getRideById);
router.get('/rides/:id/audit', admin_controller_1.AdminController.getRideAudit);
router.get('/drivers/live', admin_controller_1.AdminController.getLiveDrivers);
router.get('/drivers/dangerous', admin_controller_1.AdminController.getDangerousDrivers);
router.get('/speeding/violations', admin_controller_1.AdminController.getSpeedingViolations);
router.patch('/vehicles/:vehicleId/inspection', admin_controller_1.AdminController.verifyInspection);
router.get('/logs', admin_controller_1.AdminController.getLogs);
// Profile-change approval queue
router.get('/profile-changes', admin_controller_1.AdminController.listProfileChanges);
router.get('/profile-changes/:id', admin_controller_1.AdminController.getProfileChange);
router.post('/profile-changes/:id/approve', admin_controller_1.AdminController.approveProfileChange);
router.post('/profile-changes/:id/reject', admin_controller_1.AdminController.rejectProfileChange);
// Payout cards
router.get('/payout-cards', admin_controller_1.AdminController.listPayoutCards);
router.post('/payout-cards/:id/approve', admin_controller_1.AdminController.approvePayoutCard);
router.post('/payout-cards/:id/reject', admin_controller_1.AdminController.rejectPayoutCard);
// Payouts
router.get('/payouts', admin_controller_1.AdminController.listPayouts);
router.post('/payouts/:id/mark-paid', admin_controller_1.AdminController.markPayoutPaid);
// Document resubmission requirements
router.post('/users/:id/request-docs', admin_controller_1.AdminController.requestDocumentResubmission);
router.get('/users/:id/document-requirements', admin_controller_1.AdminController.getDriverDocumentRequirements);
router.patch('/document-requirements/:id/review', admin_controller_1.AdminController.reviewDocumentRequirement);
// Admin image/document management
router.post('/users/:id/upload-document', admin_controller_1.AdminController.uploadUserDocument);
router.delete('/users/:id/document', admin_controller_1.AdminController.deleteUserDocument);
// Vehicle submission review (025 / 026)
router.get('/vehicles/submissions', admin_controller_1.AdminController.listVehicleSubmissions);
router.get('/vehicles/submissions/:id', admin_controller_1.AdminController.getVehicleSubmission);
router.post('/vehicles/submissions/:id/approve', admin_controller_1.AdminController.approveVehicleSubmission);
router.post('/vehicles/submissions/:id/reject', admin_controller_1.AdminController.rejectVehicleSubmission);
router.post('/vehicles/submissions/:id/request-changes', admin_controller_1.AdminController.requestVehicleChanges);
router.post('/users/:id/request-vehicle-resubmission', admin_controller_1.AdminController.requestVehicleResubmission);
exports.default = router;
//# sourceMappingURL=admin.routes.js.map