// backend/src/modules/admin/admin-rewards.routes.ts
//
// Partner / promo / referral / credits / ledgers — all behind admin auth.

import { Router } from 'express';
import { authMiddleware, adminMiddleware } from '../../middleware/auth.middleware';
import { AdminRewardsController } from './admin-rewards.controller';

const router = Router();

router.use(authMiddleware);
router.use(adminMiddleware);

// ---- Partners ----------------------------------------------------------
router.get('/partners', AdminRewardsController.listPartners);
router.post('/partners', AdminRewardsController.createPartner);
router.get('/portal-users', AdminRewardsController.searchPortalUsers);
router.get('/partners/export', AdminRewardsController.exportPartners);
router.get('/partners/:id', AdminRewardsController.getPartner);
router.patch('/partners/:id', AdminRewardsController.updatePartner);
router.delete('/partners/:id', AdminRewardsController.deletePartner);
router.post('/partners/:id/status/:status', AdminRewardsController.setPartnerStatus);
router.get('/partners/:id/commissions', AdminRewardsController.listPartnerCommissions);
router.get('/partners/:id/rides/export', AdminRewardsController.exportPartnerRides);
router.post('/partners/:id/commissions/:commissionId/mark-paid', AdminRewardsController.markCommissionPaid);

// ---- Promo codes -------------------------------------------------------
router.get('/promos', AdminRewardsController.listPromos);
router.post('/promos', AdminRewardsController.createPromo);
router.get('/promos/:id', AdminRewardsController.getPromo);
router.patch('/promos/:id', AdminRewardsController.updatePromo);
router.delete('/promos/:id', AdminRewardsController.deletePromo);
router.post('/promos/:id/activate', AdminRewardsController.setPromoActive);
router.post('/promos/:id/deactivate', AdminRewardsController.setPromoActive);
router.post('/promos/:id/clone', AdminRewardsController.clonePromo);

// ---- Referrals ---------------------------------------------------------
router.get('/referrals/stats', AdminRewardsController.referralStats);
router.get('/referrals/abuse', AdminRewardsController.referralAbuse);
router.get('/referrals', AdminRewardsController.listReferrals);

// ---- Ride credits ------------------------------------------------------
router.get('/credits', AdminRewardsController.listCreditAccounts);
router.post('/credits/grant', AdminRewardsController.grantCredits);
router.get('/credits/transactions', AdminRewardsController.creditTransactionsAdmin);
router.get('/credits/transactions/export', AdminRewardsController.exportCreditLedger);

// ---- Ledgers -----------------------------------------------------------
router.get('/ledger/commissions', AdminRewardsController.commissionLedger);
router.get('/ledger/rewards', AdminRewardsController.rewardLedger);

export default router;
