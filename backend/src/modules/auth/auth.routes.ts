// backend/src/modules/auth/auth.routes.ts
import { Router } from 'express';
import { AuthController } from './auth.controller';
import { authMiddleware } from '../../middleware/auth.middleware';

const router = Router();

router.post('/oauth', AuthController.oauth);
router.post('/request-otp', AuthController.requestOTP);
router.post('/verify-otp', AuthController.verifyOTP);

// Password Routes
router.post('/signup-password', AuthController.signupPassword);
router.post('/login-password', AuthController.loginPassword);
router.post('/change-password', authMiddleware, AuthController.changePassword);
router.post('/request-password-change', authMiddleware, AuthController.requestPasswordChange);
router.post('/forgot-password', AuthController.forgotPassword);
router.post('/reset-password', AuthController.resetPassword);
router.get('/reset-password', AuthController.renderResetPasswordForm);
router.delete('/account', authMiddleware, AuthController.deleteAccount);
router.post('/deactivate-account', authMiddleware, AuthController.deactivateAccount);

export default router;
