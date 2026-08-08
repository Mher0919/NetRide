// backend/src/modules/wallet/wallet.routes.ts
import { Router } from 'express';
import { authMiddleware, riderMiddleware, adminMiddleware } from '../../middleware/auth.middleware';
import { WalletController } from './wallet.controller';

const router = Router();

router.get('/', authMiddleware, riderMiddleware, WalletController.getBalance);
router.get('/transactions', authMiddleware, riderMiddleware, WalletController.getTransactions);
router.post('/grant', authMiddleware, adminMiddleware, WalletController.adminGrant);

export default router;
