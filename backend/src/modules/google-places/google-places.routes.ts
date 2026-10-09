// backend/src/modules/google-places/google-places.routes.ts
//
// Mounted at /api. Admin-only for Google search (cost control, spec §24/§39);
// authenticated for business details (riders + admins); photo proxy is
// public but requires the server-signed `sig` produced by the details API.

import { Router } from 'express';
import { authMiddleware, adminMiddleware } from '../../middleware/auth.middleware';
import { GooglePlacesController } from './google-places.controller';

const router = Router();

router.get('/places/nearby', authMiddleware, adminMiddleware, GooglePlacesController.nearby);
router.get('/places/text-search', authMiddleware, adminMiddleware, GooglePlacesController.search);
router.get('/places/photo', GooglePlacesController.photo);
router.get('/places/business/:placeId', authMiddleware, GooglePlacesController.details);

export default router;
