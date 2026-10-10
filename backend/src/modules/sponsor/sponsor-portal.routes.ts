// backend/src/modules/sponsor/sponsor-portal.routes.ts
//
// Sponsor portal (web) API: dashboard, validations, customers, settings.
// All protected by sponsorMiddleware (SPONSOR role + sponsorId claim
// verified against sponsor_portal_accounts per request; accounts on a
// temporary password are blocked until the forced change completes).
//
// NOTE: authentication for the sponsor portal lives on the UNIFIED portal
// (/api/portal/auth/*). The legacy /sponsor/auth/* credential login was
// removed because it bypassed email 2FA — a parallel, weaker auth path.

import { Router } from 'express';
import { authMiddleware, sponsorMiddleware } from '../../middleware/auth.middleware';
import { SponsorPortalController } from './sponsor-portal.controller';

const router = Router();

// ---- Authed portal API --------------------------------------------------
router.get('/sponsor/dashboard', authMiddleware, sponsorMiddleware, SponsorPortalController.dashboard);
router.get('/sponsor/validations', authMiddleware, sponsorMiddleware, SponsorPortalController.listValidations);
router.post('/sponsor/validations/validate', authMiddleware, sponsorMiddleware, SponsorPortalController.validate);
router.post('/sponsor/validations/:id/cancel', authMiddleware, sponsorMiddleware, SponsorPortalController.cancel);
router.get('/sponsor/customers', authMiddleware, sponsorMiddleware, SponsorPortalController.listCustomers);
router.get('/sponsor/settings', authMiddleware, sponsorMiddleware, SponsorPortalController.getSettings);
router.patch('/sponsor/settings', authMiddleware, sponsorMiddleware, SponsorPortalController.updateSettings);

// Budget funding via Stripe Checkout (the sponsor pays; the budget is only
// credited from the verified webhook, never from this redirect).
router.get('/sponsor/funding', authMiddleware, sponsorMiddleware, SponsorPortalController.fundingHistory);
router.post('/sponsor/funding/session', authMiddleware, sponsorMiddleware, SponsorPortalController.createFundingSession);

// Managed card (saved on the sponsor's Stripe customer).
router.get('/sponsor/payment-method', authMiddleware, sponsorMiddleware, SponsorPortalController.getPaymentMethod);
router.post('/sponsor/payment-method/card-setup-session', authMiddleware, sponsorMiddleware, SponsorPortalController.createCardSetupSession);

// In-dashboard card management (Stripe Elements, no external redirect).
router.post('/sponsor/payment-method/setup-intent', authMiddleware, sponsorMiddleware, SponsorPortalController.createSetupIntent);
router.post('/sponsor/payment-method/setup-intent/confirm', authMiddleware, sponsorMiddleware, SponsorPortalController.confirmSetupIntent);
router.get('/sponsor/payment-methods', authMiddleware, sponsorMiddleware, SponsorPortalController.listPaymentMethods);
router.post('/sponsor/payment-methods/:id/default', authMiddleware, sponsorMiddleware, SponsorPortalController.setDefaultPaymentMethod);
router.delete('/sponsor/payment-methods/:id', authMiddleware, sponsorMiddleware, SponsorPortalController.detachPaymentMethod);

// In-dashboard funding (Payment Element, budget credited via webhook).
router.post('/sponsor/funding/intent', authMiddleware, sponsorMiddleware, SponsorPortalController.createFundingIntent);
router.post('/sponsor/funding/intent/:paymentRowId/confirm', authMiddleware, sponsorMiddleware, SponsorPortalController.confirmFundingIntent);

// MANUAL withdrawals (once per week; window opens every Monday 00:00 UTC).
router.get('/sponsor/withdrawals', authMiddleware, sponsorMiddleware, SponsorPortalController.withdrawals);
router.post('/sponsor/withdrawals/request', authMiddleware, sponsorMiddleware, SponsorPortalController.requestWithdrawal);

export default router;