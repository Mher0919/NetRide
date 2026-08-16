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
router.get('/sponsors/redemptions', AdminSponsorController.listRedemptions);
router.get('/sponsors/:id', AdminSponsorController.getOne);
router.patch('/sponsors/:id', AdminSponsorController.update);
router.post('/sponsors/:id/status/:status', AdminSponsorController.setStatus);
router.post('/sponsors/:id/budget/adjust', AdminSponsorController.adjustBudget);
router.get('/sponsors/:id/ledger', AdminSponsorController.getLedger);
router.get('/sponsors/:id/financial-history', AdminSponsorController.getFinancialHistory);
router.get('/sponsors/:id/analytics', AdminSponsorController.getAnalytics);
router.post('/sponsors/:id/portal-account', AdminSponsorController.createPortalAccount);
router.post('/sponsors/:id/portal-account/reset-password', AdminSponsorController.resetPortalPassword);
router.post('/sponsors/:id/portal-account/disable', AdminSponsorController.disablePortalAccount);

export default router;