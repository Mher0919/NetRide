// backend/src/modules/credits/credits.routes.ts
import { Router } from 'express';
import { authMiddleware, riderMiddleware } from '../../middleware/auth.middleware';
import { CreditsController } from './credits.controller';

const router = Router();

router.get('/', authMiddleware, riderMiddleware, CreditsController.getBalance);
router.get('/transactions', authMiddleware, riderMiddleware, CreditsController.getTransactions);

export default router;
