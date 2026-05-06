"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// backend/src/modules/user/user.routes.ts
const express_1 = require("express");
const user_controller_1 = require("./user.controller");
const auth_middleware_1 = require("../../middleware/auth.middleware");
const validate_middleware_1 = require("../../middleware/validate.middleware");
const router = (0, express_1.Router)();
router.get('/profile', auth_middleware_1.authMiddleware, user_controller_1.UserController.getProfile);
router.patch('/profile', auth_middleware_1.authMiddleware, (0, validate_middleware_1.validate)(user_controller_1.updateProfileSchema), user_controller_1.UserController.updateProfile);
router.post('/verify-identity', auth_middleware_1.authMiddleware, (0, validate_middleware_1.validate)(user_controller_1.verifyIdentitySchema), user_controller_1.UserController.verifyIdentity);
// Email Change Routes
router.post('/request-email-change', auth_middleware_1.authMiddleware, user_controller_1.UserController.requestEmailChange);
router.get('/verify-email-change/:token', user_controller_1.UserController.verifyEmailChange);
exports.default = router;
//# sourceMappingURL=user.routes.js.map