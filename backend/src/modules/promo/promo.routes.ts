// backend/src/modules/promo/promo.routes.ts
import { Router } from 'express';
import { authMiddleware, riderMiddleware } from '../../middleware/auth.middleware';
import { PromoController } from './promo.controller';

const router = Router();

router.post('/validate', authMiddleware, riderMiddleware, PromoController.validate);

export default router;
