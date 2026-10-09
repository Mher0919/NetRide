// backend/src/modules/payments/admin-payments.routes.ts
//
// Admin payment oversight + reconciliation actions. Mounted at
// /api/admin/payments (auth + admin guard). Every action is audit-logged.

import { Router } from 'express';
import { authMiddleware, adminMiddleware } from '../../middleware/auth.middleware';
import { AdminPaymentsController } from './admin-payments.controller';

const router = Router();
router.use(authMiddleware);
router.use(adminMiddleware);

router.get('/overview', AdminPaymentsController.overview);
router.get('/settlements', AdminPaymentsController.listSettlements);
router.get('/events', AdminPaymentsController.listEvents);
router.get('/', AdminPaymentsController.listPayments);
router.post('/:id/reconcile', AdminPaymentsController.reconcile);
router.post('/:id/refund', AdminPaymentsController.refund);
router.post('/rides/:rideId/retry-additional-charge', AdminPaymentsController.retryAdditionalCharge);
router.post('/payouts/:payoutId/transfer', AdminPaymentsController.transferPayout);

export default router;
