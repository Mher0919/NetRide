import { Router } from 'express';
import { AppVersionController } from './app-version.controller';

const router = Router();

router.get('/version', AppVersionController.getVersion);

export default router;
