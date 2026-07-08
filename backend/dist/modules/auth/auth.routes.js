"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// backend/src/modules/auth/auth.routes.ts
const express_1 = require("express");
const auth_controller_1 = require("./auth.controller");
const auth_middleware_1 = require("../../middleware/auth.middleware");
const router = (0, express_1.Router)();
router.post('/oauth', auth_controller_1.AuthController.oauth);
router.post('/request-otp', auth_controller_1.AuthController.requestOTP);
router.post('/verify-otp', auth_controller_1.AuthController.verifyOTP);
// Phone Verification
router.post('/request-phone-otp', auth_middleware_1.authMiddleware, auth_controller_1.AuthController.requestPhoneOTP);
router.post('/verify-phone-otp', auth_middleware_1.authMiddleware, auth_controller_1.AuthController.verifyPhoneOTP);
// Password Routes
router.post('/signup-password', auth_controller_1.AuthController.signupPassword);
router.post('/login-password', auth_controller_1.AuthController.loginPassword);
router.post('/change-password', auth_middleware_1.authMiddleware, auth_controller_1.AuthController.changePassword);
router.post('/request-password-change', auth_middleware_1.authMiddleware, auth_controller_1.AuthController.requestPasswordChange);
router.post('/forgot-password', auth_controller_1.AuthController.forgotPassword);
router.post('/reset-password', auth_controller_1.AuthController.resetPassword);
router.get('/reset-password', auth_controller_1.AuthController.renderResetPasswordForm);
router.delete('/account', auth_middleware_1.authMiddleware, auth_controller_1.AuthController.deleteAccount);
router.post('/deactivate-account', auth_middleware_1.authMiddleware, auth_controller_1.AuthController.deactivateAccount);
// Admin 2FA
router.post('/admin/request-2fa', auth_controller_1.AuthController.requestAdmin2FA);
router.post('/admin/verify-2fa', auth_controller_1.AuthController.verifyAdmin2FA);
exports.default = router;
//# sourceMappingURL=auth.routes.js.map