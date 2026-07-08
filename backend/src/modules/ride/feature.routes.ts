import { Router } from 'express';
import { prisma } from '../../services/prisma.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { AuthRequest } from '../../middleware/auth.middleware';
import { io } from '../../app';
import { isTestEmail } from '../../utils/testUser';

const router = Router();

// Add a tip to a ride
router.post('/:rideId/tip', authMiddleware, async (req: AuthRequest, res) => {
    const { rideId } = req.params;
    const { amount } = req.body;
    const riderId = req.user!.id;

    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) < 0) {
        return res.status(400).json({ error: 'A valid tip amount is required.' });
    }

    try {
        const ride = await prisma.ride.findUnique({
            where: { id: rideId }
        });

        if (!ride) return res.status(404).json({ error: 'Ride not found.' });
        if (ride.rider_id !== riderId) return res.status(403).json({ error: 'Unauthorized.' });

        const numericAmount = parseFloat(amount);

        await (prisma.ride as any).update({
            where: { id: rideId },
            data: { tip_amount: numericAmount }
        });

        // Look up the rider's display name for the driver-side popup.
        // Cached per request — the same trip won't get tipped twice in
        // a few hundred ms.
        let tipperName = 'Your rider';
        try {
            const rider = await prisma.user.findUnique({
                where: { id: riderId },
                select: { full_name: true },
            });
            if (rider?.full_name) tipperName = rider.full_name;
        } catch (_) {
            // Non-fatal — popup falls back to generic name.
        }

        // Push a `tipReceived` socket event so the driver's app can play
        // the tip sound and surface a popup. The rider gets the event too
        // so the FAB on their side can play a subtle confirmation tone.
        if (ride.driver_id) {
            io.to(`driver:${ride.driver_id}`).emit('tipReceived', {
                rideId,
                amount: numericAmount,
                tipperName,
            });
        }
        io.to(`rider:${riderId}`).emit('tipReceived', {
            rideId,
            amount: numericAmount,
        });

        res.json({ message: 'Tip successfully added.' });
    } catch (err: any) {
        res.status(500).json({ error: 'Failed to process tip.' });
    }
});

// ---- Test-mode ride completion ------------------------------------------
// When both the rider and the driver are test accounts, the rider can end
// the trip without going through a payment flow. We finalize the ride
// directly (status + trajectory + wallet credit + navigation cleanup +
// socket events) instead of routing through `RideService.updateTripStatus`
// (which is locked down to the assigned driver).
router.post('/:rideId/complete-test', authMiddleware, async (req: AuthRequest, res) => {
    const { rideId } = req.params;
    const userId = req.user!.id;

    try {
        const ride: any = await prisma.ride.findUnique({ where: { id: rideId } });
        if (!ride) return res.status(404).json({ error: 'Ride not found.' });

        // Only the rider or the assigned driver can complete it. Test-mode
        // is about the payment side, not authorization.
        if (ride.rider_id !== userId && ride.driver_id !== userId) {
            return res.status(403).json({ error: 'Unauthorized.' });
        }
        if (!ride.driver_id) {
            return res.status(400).json({ error: 'No driver assigned to this ride.' });
        }
        if (ride.status === 'COMPLETED' || ride.status === 'CANCELLED') {
            return res.status(400).json({ error: 'Ride is already finalized.' });
        }

        // Confirm both sides are test accounts. isTestEmail is the same
        // check the wallet-credit path uses — if either side is real,
        // the rider must go through the normal completion flow.
        const [rider, driver] = await Promise.all([
            prisma.user.findUnique({ where: { id: ride.rider_id } }),
            prisma.user.findUnique({ where: { id: ride.driver_id } }),
        ]);
        if (!isTestEmail(rider?.email) || !isTestEmail(driver?.email)) {
            return res.status(403).json({
                error: 'Complete-test is only available for test accounts.',
            });
        }

        // Lazily import ride service helpers to avoid a circular dep.
        const { RideRepository } = await import('./ride.repository');
        const { LocationsService } = await import('../location/locations.service');
        const { NavigationService } = await import('../../services/navigation.service');
        const { SpeedingDetector } = await import('../../services/speeding_detector');
        const { DriverService } = await import('../driver/driver.service');
        const { redis } = await import('../../config/redis');

        // Mirror the COMPLETED side of updateTripStatus so wallet credit
        // and the navigation lifecycle still fire.
        const trajectory = await LocationsService.getTrajectory(rideId);
        await redis.del(`driver:${ride.driver_id}:active_trip`);
        await LocationsService.clearTrajectory(rideId);
        await NavigationService.clearTrip(rideId);

        const updated = await RideRepository.updateStatus(rideId, 'COMPLETED' as any, {
            completed_at: new Date(),
            trajectory: JSON.stringify(trajectory),
        });

        await SpeedingDetector.finalizeTrip(ride.driver_id, rideId);
        NavigationService.emitEnded(
            io, rideId, ride.driver_id, ride.rider_id,
        );

        // Wallet credit. Wrap in try/catch so a wallet bug can't block
        // the test-loop completion.
        try {
            const fareCents = Math.round(parseFloat((updated as any).fare_amount ?? '0') * 100);
            const tipCents = Math.round(parseFloat((updated as any).tip_amount ?? '0') * 100);
            const totalCents = fareCents + tipCents;
            if (totalCents > 0) {
                await DriverService.creditOnRideComplete(ride.driver_id, totalCents, rideId);
            }
            console.log(
                `[RIDE] 🧪 Test-mode: complete-test finalized ride ${rideId} ($${(totalCents / 100).toFixed(2)} credited)`,
            );
        } catch (err: any) {
            console.warn(`[RIDE] ⚠️ complete-test wallet credit failed: ${err.message}`);
        }

        io.to(`rider:${ride.rider_id}`).emit('tripUpdate', updated);
        if (ride.driver_id) {
            io.to(`driver:${ride.driver_id}`).emit('tripUpdate', updated);
        }
        io.to('monitoring:all_rides').emit('tripUpdate', updated);

        res.json({ message: 'Test trip completed.', trip: updated });
    } catch (err: any) {
        console.error(`[RIDE] complete-test failed for ${rideId}: ${err.message}`);
        res.status(500).json({ error: 'Failed to complete test trip.' });
    }
});

// Dismiss verification feedback (Green/Red banner)
router.patch('/verification/dismiss', authMiddleware, async (req: AuthRequest, res) => {
    const userId = req.user!.id;
    const role = req.user!.role;

    try {
        if (role === 'DRIVER') {
            await (prisma.driver as any).update({
                where: { user_id: userId },
                data: { verification_feedback_seen: true }
            });
        } else {
            await (prisma.user as any).update({
                where: { id: userId },
                data: { verification_feedback_seen: true }
            });
        }
        res.json({ message: 'Feedback dismissed.' });
    } catch (err: any) {
        res.status(500).json({ error: 'Failed to dismiss feedback.' });
    }
});

export default router;
