// backend/src/modules/ride/ride.routes.ts
import { Router } from 'express';
import { RideController } from './ride.controller';
import { authMiddleware, riderMiddleware, driverMiddleware } from '../../middleware/auth.middleware';
import featureRoutes from './feature.routes';

const router = Router();

// Mount Feature Routes
router.use('/', featureRoutes);

router.post('/request', authMiddleware, riderMiddleware, RideController.requestRide);
router.post('/estimate', authMiddleware, riderMiddleware, RideController.estimateRide);
router.post('/accept', authMiddleware, driverMiddleware, RideController.acceptTrip);
router.post('/rate', authMiddleware, RideController.rateRide);
router.post('/cancel', authMiddleware, riderMiddleware, RideController.cancelCurrentRide);

// Post-ride party reporting (042) — both parties may report independently.
router.get('/:id/report', authMiddleware, RideController.getReportStatus);
router.post('/:id/report', authMiddleware, RideController.submitReport);
router.get('/history', authMiddleware, RideController.getHistory);
router.get('/current', authMiddleware, RideController.getCurrent);
router.delete('/history/:id', authMiddleware, RideController.deleteHistory);

// ---- In-trip chat + masked call -----------------------------------------
// Twilio's Voice SDK calls /call/connect with no JWT (it authenticates
// via the TwiML App signing key), so we leave it outside authMiddleware.
// The other endpoints sit behind the same JWT auth the rest of the
// ride surface uses.
router.get('/:id/messages', authMiddleware, RideController.getTripMessages);
router.post('/:id/call-token', authMiddleware, RideController.mintCallToken);
router.post('/:id/call/connect', RideController.callConnectTwiML);
router.post('/:id/call/status', RideController.callStatusCallback);

export default router;
