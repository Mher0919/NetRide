"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// backend/src/modules/driver/driver.routes.ts
const express_1 = require("express");
const driver_controller_1 = require("./driver.controller");
const auth_middleware_1 = require("../../middleware/auth.middleware");
const router = (0, express_1.Router)();
router.get('/profile', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.getProfile);
router.patch('/profile', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.updateProfile);
router.post('/verify-identity', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.verifyIdentity);
router.get('/onboarding/progress', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.getOnboardingProgress);
router.post('/onboarding/step', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.saveOnboardingStep);
router.post('/onboarding/complete', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.completeOnboarding);
router.post('/onboard', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.onboard);
router.get('/vehicles', driver_controller_1.DriverController.getVehicles);
router.patch('/operating-class', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.updateOperatingClass);
router.get('/pricing', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.getPricing);
router.post('/pricing/update', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.updatePrice);
router.get('/recommendations', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.getRecommendations);
// Vehicle Model Search
router.get('/vehicle-models/search', driver_controller_1.DriverController.searchVehicleModels);
router.get('/vehicle-models/years', driver_controller_1.DriverController.getVehicleYears);
router.get('/vehicle-models/makes', driver_controller_1.DriverController.getVehicleMakes);
router.get('/vehicle-models/models', driver_controller_1.DriverController.getVehicleModelsByMake);
// Profile-change approval queue
router.post('/profile-changes', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.submitProfileChange);
router.get('/profile-changes/current', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.getCurrentProfileChange);
// Wallet + payouts
router.post('/payout-cards', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.addPayoutCard);
router.get('/wallet', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.getWallet);
router.post('/wallet/request-payout', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.requestOnDemandPayout);
router.get('/payouts', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.listMyPayouts);
// Document requirements + resubmission
router.get('/documents/requirements', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.getDocumentRequirements);
router.post('/documents/resubmit', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.resubmitDocument);
router.post('/documents/batch-resubmit', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.batchResubmitDocuments);
// New vehicle submission (025)
router.post('/vehicles/submit', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.submitNewVehicle);
router.get('/vehicles/submissions/pending', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.getPendingVehicleSubmissions);
// Vehicle resubmission requirements (026)
router.get('/vehicles/resubmission-requirements', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.getVehicleResubmissionRequirements);
router.post('/vehicles/submit-resubmission', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.submitVehicleResubmission);
exports.default = router;
//# sourceMappingURL=driver.routes.js.map