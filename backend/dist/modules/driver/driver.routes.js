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
router.post('/onboard', auth_middleware_1.authMiddleware, driver_controller_1.DriverController.onboard);
router.get('/vehicles', driver_controller_1.DriverController.getVehicles);
exports.default = router;
//# sourceMappingURL=driver.routes.js.map