import { Router } from 'express';
import { prisma } from '../../services/prisma.service';
import { pool } from '../../config/database';
import { authMiddleware } from '../../middleware/auth.middleware';
import { AuthRequest } from '../../middleware/auth.middleware';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A rider may only favorite a driver they actually completed a ride with.
 * Without this check, any authenticated rider could favorite an arbitrary
 * driver UUID and read the driver's profile/PII through GET /favorites.
 */
async function hasCompletedRideWith(riderId: string, driverId: string): Promise<boolean> {
    const res = await pool.query(
        `SELECT 1 FROM rides
          WHERE rider_id = $1 AND driver_id = $2 AND status = 'COMPLETED'
          LIMIT 1`,
        [riderId, driverId],
    );
    return (res.rowCount ?? 0) > 0;
}

// Add a driver to favorites
router.post('/favorites', authMiddleware, async (req: AuthRequest, res) => {
    const { driverId } = req.body;
    const riderId = req.user!.id;

    if (!driverId || typeof driverId !== 'string' || !UUID_RE.test(driverId)) {
        return res.status(400).json({ error: 'A valid driver ID is required.' });
    }

    try {
        if (!(await hasCompletedRideWith(riderId, driverId))) {
            return res.status(403).json({ error: 'You can only favorite a driver you have completed a ride with.' });
        }

        await (prisma as any).favoriteDriver.create({
            data: {
                rider_id: riderId,
                driver_id: driverId
            }
        });
        res.json({ message: 'Driver added to favorites.' });
    } catch (err: any) {
        if (err.code === 'P2002') {
            return res.status(400).json({ error: 'Driver is already in your favorites.' });
        }
        res.status(500).json({ error: 'Failed to add favorite driver.' });
    }
});

// Remove a driver from favorites
router.delete('/favorites/:driverId', authMiddleware, async (req: AuthRequest, res) => {
    const { driverId } = req.params;
    const riderId = req.user!.id;

    try {
        await (prisma as any).favoriteDriver.delete({
            where: {
                rider_id_driver_id: {
                    rider_id: riderId,
                    driver_id: driverId
                }
            }
        });
        res.json({ message: 'Driver removed from favorites.' });
    } catch (err: any) {
        res.status(500).json({ error: 'Failed to remove favorite driver.' });
    }
});

// Get all favorite drivers
router.get('/favorites', authMiddleware, async (req: AuthRequest, res) => {
    const riderId = req.user!.id;

    try {
        const favorites = await (prisma as any).favoriteDriver.findMany({
            where: { rider_id: riderId },
            include: {
                driver: {
                    // Only public-facing driver card fields. The Driver model
                    // also holds license/insurance/registration document URLs
                    // and the FCM token; returning the whole record here leaked
                    // private onboarding data to any rider who had completed a
                    // trip with the driver.
                    select: {
                        user_id: true,
                        rating: true,
                        total_rides: true,
                        is_active: true,
                        user: {
                            select: {
                                full_name: true,
                                profile_image_url: true,
                                rating: true,
                                rating_count: true,
                                phone_number: true
                            }
                        }
                    }
                }
            }
        });
        res.json(favorites);
    } catch (err: any) {
        res.status(500).json({ error: 'Failed to retrieve favorite drivers.' });
    }
});

export default router;
