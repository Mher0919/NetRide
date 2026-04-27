// backend/src/modules/admin/admin.routes.ts
import { Router } from 'express';
import { AdminController } from './admin.controller';

const router = Router();

// These are public GET links for the email
router.get('/verify-driver/:userId', AdminController.verifyDriver);
router.get('/verify-rider/:userId', AdminController.verifyRider);

export default router;
