// backend/src/modules/referral/referral.routes.ts
import { Router } from 'express';
import { authMiddleware, riderMiddleware } from '../../middleware/auth.middleware';
import { ReferralController } from './referral.controller';

const router = Router();

router.get('/', authMiddleware, riderMiddleware, ReferralController.info);
router.get('/history', authMiddleware, riderMiddleware, ReferralController.history);
router.get('/onboarding-status', authMiddleware, riderMiddleware, ReferralController.onboardingStatus);
router.post('/scan', authMiddleware, riderMiddleware, ReferralController.scan);
router.post('/skip', authMiddleware, riderMiddleware, ReferralController.skip);

export default router;
