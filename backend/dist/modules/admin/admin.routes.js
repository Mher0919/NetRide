"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// backend/src/modules/admin/admin.routes.ts
const express_1 = require("express");
const admin_controller_1 = require("./admin.controller");
const router = (0, express_1.Router)();
// These are public GET links for the email
router.get('/verify-driver/:userId', admin_controller_1.AdminController.verifyDriver);
router.get('/verify-rider/:userId', admin_controller_1.AdminController.verifyRider);
exports.default = router;
//# sourceMappingURL=admin.routes.js.map