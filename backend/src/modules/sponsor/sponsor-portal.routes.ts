// backend/src/modules/sponsor/sponsor-portal.routes.ts
//
// Sponsor portal (web) API: auth, dashboard, validations, customers,
// settings. All protected by sponsorMiddleware (SPONSOR role + sponsorId
// claim verified against sponsor_portal_accounts per request).

import { Router } from 'express';
import { authMiddleware, sponsorMiddleware } from '../../middleware/auth.middleware';
import { SponsorPortalController } from './sponsor-portal.controller';

const router = Router();

// ---- Auth (public) -----------------------------------------------------
router.post('/sponsor/auth/login', SponsorPortalController.login);
router.post('/sponsor/auth/change-password', authMiddleware, sponsorMiddleware, SponsorPortalController.changePassword);

// ---- Authed portal API --------------------------------------------------
router.get('/sponsor/dashboard', authMiddleware, sponsorMiddleware, SponsorPortalController.dashboard);
router.get('/sponsor/validations', authMiddleware, sponsorMiddleware, SponsorPortalController.listValidations);
router.post('/sponsor/validations/validate', authMiddleware, sponsorMiddleware, SponsorPortalController.validate);
router.post('/sponsor/validations/:id/cancel', authMiddleware, sponsorMiddleware, SponsorPortalController.cancel);
router.get('/sponsor/customers', authMiddleware, sponsorMiddleware, SponsorPortalController.listCustomers);
router.get('/sponsor/settings', authMiddleware, sponsorMiddleware, SponsorPortalController.getSettings);
router.patch('/sponsor/settings', authMiddleware, sponsorMiddleware, SponsorPortalController.updateSettings);

export default router;