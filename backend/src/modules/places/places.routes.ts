import { Router } from 'express';
import { PlacesController } from './places.controller';
import { authMiddleware } from '../../middleware/auth.middleware';

const router = Router();

router.get('/search', authMiddleware, PlacesController.search);
router.get('/categories', authMiddleware, PlacesController.categories);
router.get('/count', authMiddleware, PlacesController.count);

export default router;
