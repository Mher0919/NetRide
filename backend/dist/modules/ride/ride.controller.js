"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RideController = void 0;
const ride_service_1 = require("./ride.service");
const ride_repository_1 = require("./ride.repository");
const zod_1 = require("zod");
const types_1 = require("../../types");
const prisma_service_1 = require("../../services/prisma.service");
const pricing_service_1 = require("../../services/pricing.service");
const geospatial_service_1 = require("../geospatial/geospatial.service");
const ride_messages_repository_1 = require("./ride_messages.repository");
const twilio_service_1 = require("../../services/twilio.service");
const push_notification_service_1 = require("../../services/push-notification.service");
const database_1 = require("../../config/database");
const report_service_1 = require("../reporting/report.service");
const report_reasons_1 = require("../reporting/report.reasons");
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
    scheduledAt: zod_1.z.string().datetime().nullish(),
    isScheduled: zod_1.z.boolean().optional(),
    favoritePriority: zod_1.z.boolean().optional(),
    idempotencyKey: zod_1.z.string().uuid().optional(),
    promoCode: zod_1.z.string().trim().min(2).max(32).optional(),
    applyCredits: zod_1.z.boolean().optional(),
    creditUseCents: zod_1.z.number().int().min(1).optional(),
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
});
const RateRideSchema = zod_1.z.object({
    ride_id: zod_1.z.string().uuid(),
    rating: zod_1.z.number().int().min(1).max(5),
    review_text: zod_1.z.string().optional(),
    favorite: zod_1.z.boolean().optional(), // Added for favorite logic
});
const SubmitReportSchema = zod_1.z.object({
    reason_code: zod_1.z.string().trim().min(1).max(64),
    reason_text: zod_1.z.string().trim().max(300).optional(),
    description: zod_1.z.string().trim().min(10).max(2000),
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
            const trip = await ride_service_1.RideService.requestRide(riderId, validatedData.pickup, validatedData.destination, validatedData.scheduledAt ? new Date(validatedData.scheduledAt) : undefined, validatedData.isScheduled, validatedData.idempotencyKey, { promoCode: validatedData.promoCode, applyCredits: validatedData.applyCredits, creditUseCents: validatedData.creditUseCents }, validatedData.favoritePriority);
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
            // Calculate distance using the routing service, but never block the request on
            // a slow/unreachable router — fall back to a synthetic distance fast.
            const route = await Promise.race([
                geospatial_service_1.GeospatialService.getRoute([validatedData.pickup.lat, validatedData.pickup.lng], [validatedData.destination.lat, validatedData.destination.lng]).catch(() => null),
                new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
            ]).catch(() => null);
            const distanceKm = route ? (route.distance / 1000) : 10.0; // fallback to 10km
            const breakdown = (0, pricing_service_1.computeEstimate)({
                distanceMeters: distanceKm * 1000,
                durationSeconds: route ? route.eta : 600,
            });
            res.json({
                distance_km: distanceKm,
                duration_seconds: route ? route.eta : 600,
                fare: breakdown,
                total_fare: breakdown.totalFare,
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
    /**
     * The user's active trip (any non-terminal status), role-aware. Used by
     * the rider app to hydrate the trip screen when it is opened from a push
     * notification deep link (e.g. "Your driver has arrived" → /trip).
     */
    static async getCurrent(req, res) {
        try {
            const userId = req.user?.id;
            const role = req.user?.role;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const activeRole = role === 'DRIVER' ? types_1.UserRole.DRIVER : types_1.UserRole.RIDER;
            const trip = await ride_service_1.RideService.getCurrentRide(userId, activeRole);
            if (!trip)
                return res.json({ trip: null });
            if (trip.status === 'COMPLETED' || trip.status === 'CANCELLED') {
                return res.json({ trip: null });
            }
            return res.json({ trip });
        }
        catch (error) {
            console.error(`[RIDE] ❌ Get current ride error: ${error.message}`);
            res.status(500).json({ error: 'Failed to load current ride.' });
        }
    }
    /**
     * Idempotent cancel of the rider's current request, by rider identity.
     * Accepts an optional `tripId` so the client can cancel the EXACT ride it
     * is showing (its socket tripUpdate already carries the id). Without one
     * (race window before the first tripUpdate), only an inferred REQUESTED
     * ("searching") ride is cancelled — an ACCEPTED/IN_PROGRESS ride is never
     * cancelled by inference, which is what previously produced the bogus
     * "already in progress" 409 after the real request had already been
     * cancelled through the socket path. Always returns 200 when there is
     * nothing active to cancel.
     */
    static async cancelCurrentRide(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const body = req.body ?? {};
            const requestedTripId = typeof body.tripId === 'string' && body.tripId.trim().length > 0
                ? body.tripId.trim()
                : null;
            let trip = null;
            if (requestedTripId) {
                const found = await ride_repository_1.RideRepository.findById(requestedTripId);
                // Never cancel a ride the caller doesn't own.
                if (found && found.rider_id === userId)
                    trip = found;
            }
            else {
                const current = await ride_service_1.RideService.getCurrentRide(userId, types_1.UserRole.RIDER);
                if (current && current.status === types_1.TripStatus.REQUESTED)
                    trip = current;
            }
            if (!trip) {
                return res.json({ cancelled: false, tripId: null });
            }
            // Terminal already — the parallel socket path cancelled it first, or a
            // prior call did. Report success-with-no-op (idempotent).
            if (trip.status === types_1.TripStatus.CANCELLED || trip.status === types_1.TripStatus.COMPLETED) {
                return res.json({ cancelled: true, tripId: trip.id });
            }
            // Requested / accepted / in-progress rides are all cancellable; the
            // authoritative status guard lives in RideService.cancelTrip (only
            // COMPLETED rides are terminal). We also allow cancelling a current
            // (non-REQUESTED) ride explicitly identified by tripId.
            await ride_service_1.RideService.cancelTrip(trip.id, userId, {
                reasonCode: body?.reasonCode,
                reasonText: body?.reasonText,
            });
            res.json({ cancelled: true, tripId: trip.id });
        }
        catch (error) {
            console.error(`[RIDE] ❌ Cancel current ride error: ${error.message}`);
            res.status(400).json({ error: 'Unable to cancel the ride. Please try again.' });
        }
    }
    // ---- Post-ride party reporting (042) --------------------------------
    /**
     * Can the caller file a report for this ride? Returns the other party's
     * identity + the role-scoped reason list so the app can render the
     * report sheet without hardcoding codes.
     */
    static async getReportStatus(req, res) {
        try {
            const userId = req.user?.id;
            const role = req.user?.role;
            const rideId = req.params.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const status = await report_service_1.ReportService.getReportStatus(rideId, userId, role);
            const reporterRole = (role === 'DRIVER' ? 'DRIVER' : 'RIDER');
            res.json({ ...status, reasons: status.canReport ? report_reasons_1.REPORT_REASONS[reporterRole] : [] });
        }
        catch (error) {
            console.error(`[RIDE] ❌ Report status error: ${error.message}`);
            res.status(500).json({ error: 'Failed to load report status.' });
        }
    }
    /**
     * File a report against the other ride party. Both parties may report
     * independently — each gets exactly one report per ride.
     */
    static async submitReport(req, res) {
        try {
            const userId = req.user?.id;
            const role = req.user?.role;
            const rideId = req.params.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const validatedData = SubmitReportSchema.parse(req.body);
            const report = await report_service_1.ReportService.submitReport(rideId, userId, role, validatedData);
            res.status(201).json(report);
        }
        catch (error) {
            console.error(`[RIDE] ❌ Report submission error: ${error.message}`);
            const status = error?.status ?? 400;
            res.status(status).json({ error: error?.message || 'Failed to submit report.' });
        }
    }
    // ---- In-trip chat + native phone dialing ----------------------------
    /**
     * Return the OTHER ride party's authoritative phone number so the app
     * can open the native dialer (tel: URI). Party-only + derived from the
     * users table — the peer can never inject a phone number through ride
     * payloads. Returns 404 when the other party has no usable number.
     */
    static async getPartyPhone(req, res) {
        try {
            const userId = req.user?.id;
            const role = req.user?.role;
            const rideId = req.params.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const party = await RideController.assertTripParty(rideId, userId, role);
            if (!party.ok)
                return res.status(party.code).json({ error: party.error });
            const trip = party.trip;
            const otherId = trip.rider_id === userId ? trip.driver_id : trip.rider_id;
            if (!otherId) {
                return res.status(409).json({ error: 'The other party is not on this ride anymore.' });
            }
            const other = await database_1.pool.query(`SELECT id, full_name, phone_number FROM users WHERE id = $1`, [otherId]);
            const row = other.rows[0];
            const phone = row?.phone_number?.toString?.();
            if (!row || !phone || phone.trim().length === 0) {
                return res.status(404).json({ error: 'Unable to call this user.' });
            }
            res.json({ phone_number: phone.trim(), full_name: row.full_name || '' });
        }
        catch (error) {
            console.error(`[RIDE] ❌ Party phone error: ${error.message}`);
            res.status(500).json({ error: 'Failed to load the contact number.' });
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
            // Notify the other party via push (non-blocking)
            const counterpartId = party.trip.rider_id === userId
                ? party.trip.driver_id
                : party.trip.rider_id;
            const counterpartRole = party.trip.rider_id === userId ? 'driver' : 'rider';
            try {
                const senderRes = await database_1.pool.query('SELECT full_name FROM users WHERE id = $1', [userId]);
                const senderName = senderRes.rows[0]?.full_name || 'Someone';
                await (0, push_notification_service_1.pushIncomingCall)(counterpartId, counterpartRole, senderName, tripId);
            }
            catch (pushErr) {
                console.error(`[RIDE] ⚠️ Incoming call push failed (non-fatal): ${pushErr.message}`);
            }
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