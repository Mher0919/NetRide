// backend/src/modules/referral/referral.routes.ts
import { Router } from 'express';
import { authMiddleware, riderMiddleware } from '../../middleware/auth.middleware';
import { ReferralController } from './referral.controller';

const router = Router();

router.get('/', authMiddleware, riderMiddleware, ReferralController.info);
router.get('/history', authMiddleware, riderMiddleware, ReferralController.history);
router.post('/scan', authMiddleware, riderMiddleware, ReferralController.scan);

export default router;
