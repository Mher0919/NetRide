import { Router } from 'express';
import { prisma } from '../../services/prisma.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { AuthRequest } from '../../middleware/auth.middleware';

const router = Router();

// Add a driver to favorites
router.post('/favorites', authMiddleware, async (req: AuthRequest, res) => {
    const { driverId } = req.body;
    const riderId = req.user!.id;

    if (!driverId) {
        return res.status(400).json({ error: 'Driver ID is required.' });
    }

    try {
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
                    include: {
                        user: {
                            select: {
                                full_name: true,
                                profile_image_url: true,
                                rating: true,
                                rating_count: true
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
