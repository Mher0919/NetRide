// backend/src/modules/sponsor/specials.routes.ts
//
// Rider-facing SPECIALS endpoints. Discovery of sponsors (public bounds),
// plus the redemption lifecycle (authenticated rider only).
//
// IMPORTANT: static/prefix routes (/redemptions/, /count, /intro-state) are
// registered BEFORE /:id so Express never shadow-captures them into `id`.

import { Router } from 'express';
import { authMiddleware, riderMiddleware } from '../../middleware/auth.middleware';
import { SpecialsController } from './specials.controller';

const router = Router();

// Static + prefix routes first (never shadowed by :id).
router.get('/specials/count', SpecialsController.count);
router.get('/specials/intro-state', authMiddleware, riderMiddleware, SpecialsController.getIntroState);
router.post('/specials/intro-seen', authMiddleware, riderMiddleware, SpecialsController.markIntroSeen);
router.get('/specials/redemptions/current', authMiddleware, riderMiddleware, SpecialsController.currentRedemption);
router.get('/specials/redemptions/pending', authMiddleware, riderMiddleware, SpecialsController.pendingRedemptions);
router.post('/specials/redemptions/:id/verified', authMiddleware, riderMiddleware, SpecialsController.markVerified);

// GET /specials — discovery (bounded geo queries, paginated, spec §125).
router.get('/specials', SpecialsController.list);

// Google business detail for the rider sheet. Authenticated (rider/admin) so
// anonymous traffic cannot drive up Places API cost.
router.get('/specials/:id/business', authMiddleware, SpecialsController.getBusiness);

// POST /specials/:id/redemption + GET /specials/:id — UUID-only params.
router.get('/specials/:id', SpecialsController.getOne);
router.post('/specials/:id/redemption', authMiddleware, riderMiddleware, SpecialsController.createRedemption);

export default router;