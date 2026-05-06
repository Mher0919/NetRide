"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RideController = void 0;
const ride_service_1 = require("./ride.service");
const zod_1 = require("zod");
const RateRideSchema = zod_1.z.object({
    ride_id: zod_1.z.string().uuid(),
    rating: zod_1.z.number().int().min(1).max(5),
    review_text: zod_1.z.string().optional(),
});
class RideController {
    static async requestRide(req, res) {
        try {
            const riderId = req.user?.id;
            const { pickup, destination } = req.body;
            const trip = await ride_service_1.RideService.requestRide(riderId, pickup, destination);
            res.status(201).json(trip);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    static async acceptTrip(req, res) {
        try {
            const driverId = req.user?.id;
            const { tripId } = req.body;
            const trip = await ride_service_1.RideService.acceptTrip(tripId, driverId);
            res.json(trip);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    static async rateRide(req, res) {
        try {
            const riderId = req.user?.id;
            if (!riderId)
                return res.status(401).json({ error: 'Unauthorized' });
            const validatedData = RateRideSchema.parse(req.body);
            const result = await ride_service_1.RideService.rateRide({
                ...validatedData,
                rider_id: riderId,
            });
            res.json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    static async getHistory(req, res) {
        try {
            const userId = req.user?.id;
            const role = req.user?.role;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            console.log(`[RIDE] 📜 Fetching history for user ${userId} [Role: ${role}]`);
            const start = Date.now();
            const history = await ride_service_1.RideService.getHistory(userId, role);
            const duration = Date.now() - start;
            console.log(`[RIDE] ✅ History fetched in ${duration}ms (${history.length} records)`);
            res.json(history);
        }
        catch (error) {
            console.error(`[RIDE] ❌ Error fetching history: ${error.message}`);
            res.status(500).json({ error: error.message });
        }
    }
    static async deleteHistory(req, res) {
        try {
            const userId = req.user?.id;
            const { id } = req.params;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const success = await ride_service_1.RideService.deleteHistory(id, userId);
            if (success) {
                res.json({ message: 'Activity deleted successfully' });
            }
            else {
                res.status(404).json({ error: 'Activity not found or unauthorized' });
            }
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
}
exports.RideController = RideController;
//# sourceMappingURL=ride.controller.js.map