"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RideController = void 0;
const ride_service_1 = require("./ride.service");
const zod_1 = require("zod");
const types_1 = require("../../types");
const prisma_service_1 = require("../../services/prisma.service");
const fare_service_1 = require("../../services/fare.service");
const geospatial_service_1 = require("../geospatial/geospatial.service");
const ride_messages_repository_1 = require("./ride_messages.repository");
const twilio_service_1 = require("../../services/twilio.service");
const database_1 = require("../../config/database");
const RequestRideSchema = zod_1.z.object({
    pickup: zod_1.z.object({
        lat: zod_1.z.number(),
        lng: zod_1.z.number(),
        address: zod_1.z.string(),
    }),
    destination: zod_1.z.object({
        lat: zod_1.z.number(),
        lng: zod_1.z.number(),
        address: zod_1.z.string(),
    }),
    requestedClass: zod_1.z.nativeEnum(types_1.VehicleClass).optional(),
    scheduledAt: zod_1.z.string().datetime().optional(),
    isScheduled: zod_1.z.boolean().optional(),
});
const EstimateRideSchema = zod_1.z.object({
    pickup: zod_1.z.object({
        lat: zod_1.z.number(),
        lng: zod_1.z.number(),
    }),
    destination: zod_1.z.object({
        lat: zod_1.z.number(),
        lng: zod_1.z.number(),
    }),
    requestedClass: zod_1.z.nativeEnum(types_1.VehicleClass).optional(),
});
const RateRideSchema = zod_1.z.object({
    ride_id: zod_1.z.string().uuid(),
    rating: zod_1.z.number().int().min(1).max(5),
    review_text: zod_1.z.string().optional(),
    favorite: zod_1.z.boolean().optional(), // Added for favorite logic
});
class RideController {
    static async requestRide(req, res) {
        try {
            const riderId = req.user?.id;
            const validatedData = RequestRideSchema.parse(req.body);
            // Compliance Lock: Prevent requests if PENDING
            const user = await prisma_service_1.prisma.user.findUnique({ where: { id: riderId } });
            if (user?.verification_status === 'PENDING') {
                return res.status(403).json({ error: 'Your account is undergoing age verification. Requests are restricted until completed.' });
            }
            const trip = await ride_service_1.RideService.requestRide(riderId, validatedData.pickup, validatedData.destination, validatedData.requestedClass, validatedData.scheduledAt ? new Date(validatedData.scheduledAt) : undefined, validatedData.isScheduled);
            res.status(201).json(trip);
        }
        catch (error) {
            console.error(`[RIDE] ❌ Request error: ${error.message}`);
            res.status(400).json({ error: error.message || 'Unable to process your ride request.' });
        }
    }
    static async estimateRide(req, res) {
        try {
            const validatedData = EstimateRideSchema.parse(req.body);
            // Calculate distance using OSRM routing
            const route = await geospatial_service_1.GeospatialService.getRoute([validatedData.pickup.lat, validatedData.pickup.lng], [validatedData.destination.lat, validatedData.destination.lng]).catch(() => null);
            const distanceKm = route ? (route.distance / 1000) : 10.0; // fallback to 10km
            const estimate = await fare_service_1.fareService.calculateRiderPriceEstimate(validatedData.pickup.lat, validatedData.pickup.lng, validatedData.requestedClass || types_1.VehicleClass.CORE, distanceKm);
            res.json({
                distance_km: distanceKm,
                duration_seconds: route ? route.eta : 600,
                ...estimate
            });
        }
        catch (error) {
            console.error(`[RIDE] ❌ Estimate error: ${error.message}`);
            res.status(400).json({ error: error.message || 'Failed to calculate ride estimate.' });
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
            console.error(`[RIDE] ❌ Accept error: ${error.message}`);
            res.status(400).json({ error: error.message || 'Failed to accept trip.' });
        }
    }
    static async rateRide(req, res) {
        try {
            const raterId = req.user?.id;
            if (!raterId)
                return res.status(401).json({ error: 'Unauthorized' });
            const validatedData = RateRideSchema.parse(req.body);
            // Handle Favorite Driver Logic
            if (validatedData.favorite) {
                const ride = await prisma_service_1.prisma.ride.findUnique({ where: { id: validatedData.ride_id } });
                if (ride?.driver_id) {
                    await prisma_service_1.prisma.favoriteDriver.upsert({
                        where: {
                            rider_id_driver_id: {
                                rider_id: raterId,
                                driver_id: ride.driver_id
                            }
                        },
                        create: {
                            rider_id: raterId,
                            driver_id: ride.driver_id
                        },
                        update: {} // No change needed if already favorite
                    });
                }
            }
            const result = await ride_service_1.RideService.rateRide({
                ...validatedData,
                rater_id: raterId,
            });
            res.json(result);
        }
        catch (error) {
            console.error(`[RIDE] ❌ Rating error: ${error.message}`);
            res.status(400).json({ error: error.message || 'Failed to submit rating.' });
        }
    }
    static async getHistory(req, res) {
        try {
            const userId = req.user?.id;
            const role = req.user?.role;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const history = await ride_service_1.RideService.getHistory(userId, role);
            res.json(history);
        }
        catch (error) {
            console.error(`[RIDE] ❌ Error fetching history: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve ride history.' });
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
                res.status(404).json({ error: 'Activity record not found.' });
            }
        }
        catch (error) {
            console.error(`[RIDE] ❌ Delete history error: ${error.message}`);
            res.status(500).json({ error: 'Failed to delete activity record.' });
        }
    }
    // ---- In-trip chat + masked call ---------------------------------------
    /**
     * Verify the caller is a party to the trip. Throws nothing — returns
     * a discriminated response shape so the caller can decide between
     * 403 (not a party), 404 (no such trip), and 200 (allowed).
     *
     * `role` is optional: the Twilio webhook path doesn't have a JWT
     * (the access token IS the auth) and we want to do a row-level
     * "is this user on this trip at all" check rather than reject
     * because the caller didn't say which role they are.
     */
    static async assertTripParty(tripId, userId, role) {
        const res = await database_1.pool.query(`SELECT id, rider_id, driver_id, status FROM rides WHERE id = $1`, [tripId]);
        if (res.rows.length === 0) {
            return { ok: false, code: 404, error: 'Trip not found.' };
        }
        const trip = res.rows[0];
        if (role != null) {
            const roleLower = role.toLowerCase();
            const isRider = roleLower === 'rider' && trip.rider_id === userId;
            const isDriver = roleLower === 'driver' && trip.driver_id === userId;
            if (!isRider && !isDriver) {
                return { ok: false, code: 403, error: 'You are not a party to this trip.' };
            }
        }
        else {
            // No role provided — accept if the user is either party.
            if (trip.rider_id !== userId && trip.driver_id !== userId) {
                return { ok: false, code: 403, error: 'You are not a party to this trip.' };
            }
        }
        return { ok: true, trip };
    }
    static async getTripMessages(req, res) {
        try {
            const userId = req.user?.id;
            const role = req.user?.role;
            const tripId = req.params.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const party = await RideController.assertTripParty(tripId, userId, role);
            if (!party.ok)
                return res.status(party.code).json({ error: party.error });
            const sinceRaw = req.query.since ?? null;
            const since = sinceRaw ? new Date(sinceRaw) : undefined;
            if (since && Number.isNaN(since.getTime())) {
                return res.status(400).json({ error: 'Invalid `since` timestamp.' });
            }
            const rows = await ride_messages_repository_1.RideMessagesRepository.listByTrip(tripId, { since });
            res.json({
                tripId,
                messages: rows.map((m) => ({
                    id: m.id,
                    tripId: m.trip_id,
                    senderId: m.sender_id,
                    role: m.sender_role,
                    message: m.body,
                    timestamp: m.created_at,
                })),
            });
        }
        catch (error) {
            console.error(`[RIDE] ❌ Fetch messages error: ${error.message}`);
            res.status(500).json({ error: 'Unable to fetch messages.' });
        }
    }
    static async mintCallToken(req, res) {
        try {
            const userId = req.user?.id;
            const role = req.user?.role;
            const tripId = req.params.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const party = await RideController.assertTripParty(tripId, userId, role);
            if (!party.ok)
                return res.status(party.code).json({ error: party.error });
            const liveStatuses = [types_1.TripStatus.ACCEPTED, types_1.TripStatus.IN_PROGRESS];
            if (!liveStatuses.includes(String(party.trip.status))) {
                return res.status(409).json({ error: 'Calls are only available during an active trip.' });
            }
            if (!twilio_service_1.TwilioService.isConfigured()) {
                return res.status(503).json({
                    error: 'Calls are not enabled in this environment. Please use chat to contact your counterpart.',
                });
            }
            const callToken = twilio_service_1.TwilioService.mintAccessToken(userId, tripId);
            res.json({
                ...callToken,
                tripId,
            });
        }
        catch (error) {
            console.error(`[RIDE] ❌ Mint call token error: ${error.message}`);
            res.status(500).json({ error: 'Unable to start a call right now.' });
        }
    }
    /**
     * Twilio Voice SDK calls into this endpoint (the TwiML App URL) to
     * learn how to route the outbound leg. We always answer with a
     * <Dial><Conference> pointing at the trip's conference room. The
     * SDK-supplied "To" parameter is ignored — security lives in the
     * access-token grant.
     */
    static async callConnectTwiML(req, res) {
        try {
            const tripId = (req.body?.tripId ?? req.query?.tripId);
            const userId = (req.body?.userId ?? req.query?.userId);
            if (!tripId || !userId) {
                res.status(400).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Missing call context.</Say></Response>');
                return;
            }
            const party = await RideController.assertTripParty(tripId, userId, null);
            if (!party.ok) {
                res.status(party.code).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>You are not authorized for this call.</Say></Response>');
                return;
            }
            const xml = twilio_service_1.TwilioService.conferenceTwiML(twilio_service_1.TwilioService.conferenceNameFor(tripId));
            res.type('text/xml').send(xml);
        }
        catch (error) {
            console.error(`[RIDE] ❌ TwiML error: ${error.message}`);
            res.status(500).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Call setup failed.</Say></Response>');
        }
    }
    /**
     * Webhook for Twilio status callbacks. We log but don't act on them
     * here — billing-side metrics live in the Twilio console. Endpoint
     * exists so Twilio's request signature validation can succeed.
     */
    static async callStatusCallback(req, res) {
        try {
            const sid = req.body?.CallSid ?? '';
            const status = req.body?.CallStatus ?? '';
            console.log(`[CALL] Twilio callback sid=${sid} status=${status}`);
            res.status(204).end();
        }
        catch (error) {
            console.error(`[RIDE] ❌ Call status callback error: ${error.message}`);
            res.status(204).end();
        }
    }
}
exports.RideController = RideController;
//# sourceMappingURL=ride.controller.js.map