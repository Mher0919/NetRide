// backend/src/modules/payments/payments.routes.ts
//
// Rider + driver payment endpoints. Mounted at /api/payments.
// The Stripe webhook is NOT here — it is registered in app.ts with
// express.raw before the global JSON parser (signature verification needs
// the raw body).

import { Router } from 'express';
import { authMiddleware, driverMiddleware } from '../../middleware/auth.middleware';
import { PaymentsController } from './payments.controller';

const router = Router();

// -- Public: browser redirects from Stripe Checkout / hosted onboarding -----
router.get('/return', PaymentsController.returnHandler);
router.get('/connect/refresh', PaymentsController.connectRefresh);
router.get('/connect/return', PaymentsController.connectReturn);

// -- Authenticated (any role; data is scoped to the caller) -----------------
router.use(authMiddleware);

router.get('/config', PaymentsController.config);
router.get('/profile', PaymentsController.profile);
router.post('/setup-session', PaymentsController.setupSession);
router.post('/setup-intent', PaymentsController.setupIntent);
router.post('/setup-intent/confirm', PaymentsController.confirmSetupIntent);
router.post('/wallet/topup-session', PaymentsController.walletTopUpSession);
router.get('/methods', PaymentsController.listMethods);
router.delete('/methods/:id', PaymentsController.detachMethod);
router.post('/methods/:id/default', PaymentsController.setDefaultMethod);
router.post('/consent', PaymentsController.consent);
router.get('/ride/:rideId/status', PaymentsController.rideStatus);
router.get('/history', PaymentsController.history);

// -- Driver Connect onboarding ---------------------------------------------
router.get('/connect/status', driverMiddleware, PaymentsController.connectStatus);
router.post('/connect/onboarding', driverMiddleware, PaymentsController.connectOnboarding);

export default router;
