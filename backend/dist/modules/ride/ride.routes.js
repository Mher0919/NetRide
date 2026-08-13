"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// backend/src/modules/ride/ride.routes.ts
const express_1 = require("express");
const ride_controller_1 = require("./ride.controller");
const auth_middleware_1 = require("../../middleware/auth.middleware");
const feature_routes_1 = __importDefault(require("./feature.routes"));
const router = (0, express_1.Router)();
// Mount Feature Routes
router.use('/', feature_routes_1.default);
router.post('/request', auth_middleware_1.authMiddleware, auth_middleware_1.riderMiddleware, ride_controller_1.RideController.requestRide);
router.post('/estimate', auth_middleware_1.authMiddleware, auth_middleware_1.riderMiddleware, ride_controller_1.RideController.estimateRide);
router.post('/accept', auth_middleware_1.authMiddleware, auth_middleware_1.driverMiddleware, ride_controller_1.RideController.acceptTrip);
router.post('/rate', auth_middleware_1.authMiddleware, ride_controller_1.RideController.rateRide);
router.post('/cancel', auth_middleware_1.authMiddleware, auth_middleware_1.riderMiddleware, ride_controller_1.RideController.cancelCurrentRide);
router.get('/history', auth_middleware_1.authMiddleware, ride_controller_1.RideController.getHistory);
router.get('/current', auth_middleware_1.authMiddleware, ride_controller_1.RideController.getCurrent);
router.delete('/history/:id', auth_middleware_1.authMiddleware, ride_controller_1.RideController.deleteHistory);
// ---- In-trip chat + masked call -----------------------------------------
// Twilio's Voice SDK calls /call/connect with no JWT (it authenticates
// via the TwiML App signing key), so we leave it outside authMiddleware.
// The other endpoints sit behind the same JWT auth the rest of the
// ride surface uses.
router.get('/:id/messages', auth_middleware_1.authMiddleware, ride_controller_1.RideController.getTripMessages);
router.post('/:id/call-token', auth_middleware_1.authMiddleware, ride_controller_1.RideController.mintCallToken);
router.post('/:id/call/connect', ride_controller_1.RideController.callConnectTwiML);
router.post('/:id/call/status', ride_controller_1.RideController.callStatusCallback);
exports.default = router;
//# sourceMappingURL=ride.routes.js.map