// backend/src/modules/sponsor/admin-sponsor.routes.ts
//
// Admin Sponsor management — full CRUD + budget ledger + financial history
// (60/40 columns) + analytics + portal account management. Admin-only.

import { Router } from 'express';
import { authMiddleware, adminMiddleware } from '../../middleware/auth.middleware';
import { AdminSponsorController } from './admin-sponsor.controller';

const router = Router();
router.use(authMiddleware);
router.use(adminMiddleware);

router.get('/sponsors', AdminSponsorController.list);
router.post('/sponsors', AdminSponsorController.create);
// Business-image uploads (logo / gallery photos) for the manual-entry
// workflow. Registered before `/sponsors/:id` so "uploads" is never parsed
// as a sponsor id.
router.post('/sponsors/uploads/image', AdminSponsorController.uploadBusinessImage);
router.delete('/sponsors/uploads/image', AdminSponsorController.deleteBusinessImage);
router.get('/sponsors/redemptions', AdminSponsorController.listRedemptions);
router.get('/sponsors/:id', AdminSponsorController.getOne);
router.patch('/sponsors/:id', AdminSponsorController.update);
router.delete('/sponsors/:id', AdminSponsorController.remove);
router.post('/sponsors/:id/status/:status', AdminSponsorController.setStatus);
router.post('/sponsors/:id/budget/adjust', AdminSponsorController.adjustBudget);
router.get('/sponsors/:id/ledger', AdminSponsorController.getLedger);
router.get('/sponsors/:id/financial-history', AdminSponsorController.getFinancialHistory);
router.get('/sponsors/:id/analytics', AdminSponsorController.getAnalytics);
router.post('/sponsors/:id/portal-account', AdminSponsorController.createPortalAccount);
router.post('/sponsors/:id/portal-account/reset-password', AdminSponsorController.resetPortalPassword);
router.post('/sponsors/:id/portal-account/disable', AdminSponsorController.disablePortalAccount);
router.post('/sponsors/:id/portal-account/enable', AdminSponsorController.enablePortalAccount);

// Fleet partner portal accounts — same first-login password flow as sponsors.
router.post('/fleets/:id/portal-account', AdminSponsorController.createFleetPortalAccount);
router.post('/fleets/:id/portal-account/reset-password', AdminSponsorController.resetFleetPortalPassword);
router.post('/fleets/:id/portal-account/disable', AdminSponsorController.disableFleetPortalAccount);
router.post('/fleets/:id/portal-account/enable', AdminSponsorController.enableFleetPortalAccount);

export default router;