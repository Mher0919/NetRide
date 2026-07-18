// backend/src/modules/face/face.routes.ts
import { Router } from 'express';
import { FaceController } from './face.controller';
import {
  authMiddleware,
  adminMiddleware,
  driverMiddleware,
} from '../../middleware/auth.middleware';

const router = Router();

// Driver-side
router.get('/check-required', authMiddleware, driverMiddleware, FaceController.checkRequired);
router.post('/verify', authMiddleware, driverMiddleware, FaceController.verify);
router.post('/verify-image', authMiddleware, driverMiddleware, FaceController.verifyImage);

// Admin-side
router.get('/admin/flagged', authMiddleware, adminMiddleware, FaceController.listFlagged);
router.post('/admin/review/:eventId', authMiddleware, adminMiddleware, FaceController.review);
router.get('/admin/user/:userId', authMiddleware, adminMiddleware, FaceController.userEvents);

export default router;
