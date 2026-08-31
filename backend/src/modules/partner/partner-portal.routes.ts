// backend/src/modules/partner/partner-portal.routes.ts
//
// Partner portal (web) API: auth, dashboard, usage, earnings, commission,
// password recovery. All partners have their own isolated data.

import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware';
import { PartnerPortalController } from './partner-portal.controller';

const router = Router();

// ---- Auth (public) -----------------------------------------------------
router.post('/partner/auth/login', PartnerPortalController.login);
router.post('/partner/auth/refresh', PartnerPortalController.refresh);
router.post('/partner/auth/logout', PartnerPortalController.logout);
router.post('/partner/auth/forgot-password', PartnerPortalController.forgotPassword);
router.post('/partner/auth/verify-reset-otp', PartnerPortalController.verifyResetOTP);
router.post('/partner/auth/reset-password', PartnerPortalController.resetPassword);
router.post('/partner/auth/change-password', authMiddleware, PartnerPortalController.changePassword);

// ---- Authed partner API --------------------------------------------------
router.get('/partner/dashboard', authMiddleware, PartnerPortalController.dashboard);
router.get('/partner/usage', authMiddleware, PartnerPortalController.usage);
router.get('/partner/earnings', authMiddleware, PartnerPortalController.earnings);
router.get('/partner/commission', authMiddleware, PartnerPortalController.commission);

export default router;