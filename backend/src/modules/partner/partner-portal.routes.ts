// backend/src/modules/partner/partner-portal.routes.ts
//
// Partner portal (legacy) API: dashboard, usage, earnings, commission.
// All protected by partnerMiddleware (partner resolved from the user link;
// accounts on a temporary password are blocked until the forced change).
//
// NOTE: authentication for partner dashboards lives on the UNIFIED portal
// (/api/portal/auth/*). The legacy /partner/auth/* credential login was
// removed because it bypassed email 2FA — a parallel, weaker auth path.

import { Router } from 'express';
import { authMiddleware, partnerMiddleware } from '../../middleware/auth.middleware';
import { PartnerPortalController } from './partner-portal.controller';

const router = Router();

// ---- Authed partner API --------------------------------------------------
router.get('/partner/dashboard', authMiddleware, partnerMiddleware, PartnerPortalController.dashboard);
router.get('/partner/usage', authMiddleware, partnerMiddleware, PartnerPortalController.usage);
router.get('/partner/earnings', authMiddleware, partnerMiddleware, PartnerPortalController.earnings);
router.get('/partner/commission', authMiddleware, partnerMiddleware, PartnerPortalController.commission);

export default router;