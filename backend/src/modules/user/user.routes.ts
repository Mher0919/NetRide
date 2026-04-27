// backend/src/modules/user/user.routes.ts
import { Router } from 'express';
import { UserController, updateProfileSchema, verifyIdentitySchema } from './user.controller';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';

const router = Router();

router.get('/profile', authMiddleware, UserController.getProfile);
router.patch('/profile', authMiddleware, validate(updateProfileSchema), UserController.updateProfile);
router.post('/verify-identity', authMiddleware, validate(verifyIdentitySchema), UserController.verifyIdentity);

// Email Change Routes
router.post('/request-email-change', authMiddleware, UserController.requestEmailChange);
router.get('/verify-email-change/:token', UserController.verifyEmailChange);

export default router;
