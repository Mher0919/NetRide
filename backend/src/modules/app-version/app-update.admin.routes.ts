import { Router } from 'express';
import {
  adminMiddleware,
  authMiddleware,
} from '../../middleware/auth.middleware';
import { AppUpdateAdminController } from './app-update.admin.controller';

const router = Router();

router.use(authMiddleware);
router.use(adminMiddleware);

router.get('/app-updates', AppUpdateAdminController.list);
router.get('/app-updates/:app/:platform', AppUpdateAdminController.getOne);
router.get(
  '/app-updates/:app/:platform/history',
  AppUpdateAdminController.history,
);
router.put(
  '/app-updates/:app/:platform/draft',
  AppUpdateAdminController.saveDraft,
);
router.delete(
  '/app-updates/:app/:platform/draft',
  AppUpdateAdminController.discardDraft,
);
router.post(
  '/app-updates/:app/:platform/publish',
  AppUpdateAdminController.publish,
);
router.post(
  '/app-updates/:app/:platform/deactivate',
  AppUpdateAdminController.deactivate,
);

export default router;
