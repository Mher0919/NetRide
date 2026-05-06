// backend/src/modules/ride/ride.controller.ts
import { Response } from 'express';
import { RideService } from './ride.service';
import { z } from 'zod';

const RateRideSchema = z.object({
  ride_id: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  review_text: z.string().optional(),
});

export class RideController {
  static async requestRide(req: any, res: Response) {
    try {
      const riderId = req.user?.id;
      const { pickup, destination } = req.body;
      const trip = await RideService.requestRide(riderId, pickup, destination);
      res.status(201).json(trip);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async acceptTrip(req: any, res: Response) {
    try {
      const driverId = req.user?.id;
      const { tripId } = req.body;
      const trip = await RideService.acceptTrip(tripId, driverId);
      res.json(trip);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async rateRide(req: any, res: Response) {
    try {
      const riderId = req.user?.id;
      if (!riderId) return res.status(401).json({ error: 'Unauthorized' });

      const validatedData = RateRideSchema.parse(req.body);
      const result = await RideService.rateRide({
        ...validatedData,
        rider_id: riderId,
      });
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async getHistory(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      const role = req.user?.role;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      console.log(`[RIDE] 📜 Fetching history for user ${userId} [Role: ${role}]`);
      const start = Date.now();
      const history = await RideService.getHistory(userId, role);
      const duration = Date.now() - start;
      console.log(`[RIDE] ✅ History fetched in ${duration}ms (${history.length} records)`);
      
      res.json(history);
    } catch (error: any) {
      console.error(`[RIDE] ❌ Error fetching history: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  }

  static async deleteHistory(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      const { id } = req.params;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const success = await RideService.deleteHistory(id, userId);
      if (success) {
        res.json({ message: 'Activity deleted successfully' });
      } else {
        res.status(404).json({ error: 'Activity not found or unauthorized' });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
