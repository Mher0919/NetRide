"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// backend/src/modules/ride/ride.routes.ts
const express_1 = require("express");
const ride_controller_1 = require("./ride.controller");
const auth_middleware_1 = require("../../middleware/auth.middleware");
const router = (0, express_1.Router)();
router.post('/request', auth_middleware_1.authMiddleware, ride_controller_1.RideController.requestRide);
router.post('/accept', auth_middleware_1.authMiddleware, ride_controller_1.RideController.acceptTrip);
router.post('/rate', auth_middleware_1.authMiddleware, ride_controller_1.RideController.rateRide);
router.get('/history', auth_middleware_1.authMiddleware, ride_controller_1.RideController.getHistory);
router.delete('/history/:id', auth_middleware_1.authMiddleware, ride_controller_1.RideController.deleteHistory);
exports.default = router;
//# sourceMappingURL=ride.routes.js.map