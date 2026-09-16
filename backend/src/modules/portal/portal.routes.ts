// backend/src/modules/portal/portal.routes.ts
//
// Unified portal (sponsor / partner / fleet) — mounted at /api/portal.

import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware';
import { portalMiddleware } from '../../middleware/portal.middleware';
import { PortalController } from './portal.controller';

const router = Router();

// ---- Auth (public) -----------------------------------------------------
router.post('/portal/auth/login', PortalController.login);
router.post('/portal/auth/verify-2fa', PortalController.verify2FA);
router.post('/portal/auth/refresh', PortalController.refresh);
router.post('/portal/auth/logout', PortalController.logout);
router.post('/portal/auth/forgot-password', PortalController.forgotPassword);
router.post('/portal/auth/verify-reset-otp', PortalController.verifyResetOTP);
router.post('/portal/auth/reset-password', PortalController.resetPassword);
router.post('/portal/auth/change-password', authMiddleware, portalMiddleware, PortalController.changePassword);

// ---- Authed (type-aware) -----------------------------------------------
router.get('/portal/dashboard', authMiddleware, portalMiddleware, PortalController.dashboard);
router.get('/portal/usage', authMiddleware, portalMiddleware, PortalController.usage);
router.get('/portal/earnings', authMiddleware, portalMiddleware, PortalController.earnings);
router.get('/portal/commission', authMiddleware, portalMiddleware, PortalController.commission);
router.get('/portal/fleet/drivers', authMiddleware, portalMiddleware, PortalController.fleetDrivers);
router.get('/portal/fleet/rides', authMiddleware, portalMiddleware, PortalController.fleetRides);

export default router;