// backend/src/modules/ride/ride.controller.ts
import { Response } from 'express';
import { RideService } from './ride.service';
import { z } from 'zod';
import { TripStatus, UserRole } from '../../types';
import { prisma } from '../../services/prisma.service';

import { computeEstimate } from '../../services/pricing.service';
import { GeospatialService } from '../geospatial/geospatial.service';
import { RideMessagesRepository } from './ride_messages.repository';
import { TwilioService } from '../../services/twilio.service';
import { pushIncomingCall } from '../../services/push-notification.service';
import { pool } from '../../config/database';
import { ReportService } from '../reporting/report.service';
import { REPORT_REASONS, PartyRole } from '../reporting/report.reasons';

const RequestRideSchema = z.object({
  pickup: z.object({
    lat: z.number(),
    lng: z.number(),
    address: z.string(),
  }),
  destination: z.object({
    lat: z.number(),
    lng: z.number(),
    address: z.string(),
  }),
  scheduledAt: z.string().datetime().nullish(),
  isScheduled: z.boolean().optional(),
  favoritePriority: z.boolean().optional(),
  idempotencyKey: z.string().uuid().optional(),
  promoCode: z.string().trim().min(2).max(32).optional(),
  applyCredits: z.boolean().optional(),
  creditUseCents: z.number().int().min(1).optional(),
});

const EstimateRideSchema = z.object({
  pickup: z.object({
    lat: z.number(),
    lng: z.number(),
  }),
  destination: z.object({
    lat: z.number(),
    lng: z.number(),
  }),
});

const RateRideSchema = z.object({
  ride_id: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  review_text: z.string().optional(),
  favorite: z.boolean().optional(), // Added for favorite logic
});

const SubmitReportSchema = z.object({
  reason_code: z.string().trim().min(1).max(64),
  reason_text: z.string().trim().max(300).optional(),
  description: z.string().trim().min(10).max(2000),
});

export class RideController {
  static async requestRide(req: any, res: Response) {
    try {
      const riderId = req.user?.id;
      const validatedData = RequestRideSchema.parse(req.body);

      // Compliance Lock: Prevent requests if PENDING
      const user = await prisma.user.findUnique({ where: { id: riderId } });
      if (user?.verification_status === 'PENDING') {
        return res.status(403).json({ error: 'Your account is undergoing age verification. Requests are restricted until completed.' });
      }

      const trip = await RideService.requestRide(
        riderId, 
        validatedData.pickup, 
        validatedData.destination,
        validatedData.scheduledAt ? new Date(validatedData.scheduledAt) : undefined,
        validatedData.isScheduled,
        validatedData.idempotencyKey,
        { promoCode: validatedData.promoCode, applyCredits: validatedData.applyCredits, creditUseCents: validatedData.creditUseCents },
        validatedData.favoritePriority
      );
      res.status(201).json(trip);
    } catch (error: any) {
      console.error(`[RIDE] ❌ Request error: ${error.message}`);
      res.status(400).json({ error: error.message || 'Unable to process your ride request.' });
    }
  }

  static async estimateRide(req: any, res: Response) {
    try {
      const validatedData = EstimateRideSchema.parse(req.body);

      // Calculate distance using the routing service, but never block the request on
      // a slow/unreachable router — fall back to a synthetic distance fast.
      const route = await Promise.race<unknown>([
        GeospatialService.getRoute(
          [validatedData.pickup.lat, validatedData.pickup.lng],
          [validatedData.destination.lat, validatedData.destination.lng]
        ).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
      ]).catch(() => null) as any;

      const distanceKm = route ? (route.distance / 1000) : 10.0; // fallback to 10km

      const breakdown = computeEstimate({
        distanceMeters: distanceKm * 1000,
        durationSeconds: route ? route.eta : 600,
      });

      res.json({
        distance_km: distanceKm,
        duration_seconds: route ? route.eta : 600,
        fare: breakdown,
        total_fare: breakdown.totalFare,
      });
    } catch (error: any) {
      console.error(`[RIDE] ❌ Estimate error: ${error.message}`);
      res.status(400).json({ error: error.message || 'Failed to calculate ride estimate.' });
    }
  }

  static async acceptTrip(req: any, res: Response) {
    try {
      const driverId = req.user?.id;
      const { tripId } = req.body;
      const trip = await RideService.acceptTrip(tripId, driverId);
      res.json(trip);
    } catch (error: any) {
      console.error(`[RIDE] ❌ Accept error: ${error.message}`);
      res.status(400).json({ error: error.message || 'Failed to accept trip.' });
    }
  }

  static async rateRide(req: any, res: Response) {
    try {
      const raterId = req.user?.id;
      if (!raterId) return res.status(401).json({ error: 'Unauthorized' });

      const validatedData = RateRideSchema.parse(req.body);
      
      // Handle Favorite Driver Logic
      if (validatedData.favorite) {
        const ride = await prisma.ride.findUnique({ where: { id: validatedData.ride_id } });
        if (ride?.driver_id) {
          await (prisma as any).favoriteDriver.upsert({
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

      const result = await RideService.rateRide({
        ...validatedData,
        rater_id: raterId,
      });
      res.json(result);
    } catch (error: any) {
      console.error(`[RIDE] ❌ Rating error: ${error.message}`);
      res.status(400).json({ error: error.message || 'Failed to submit rating.' });
    }
  }

  static async getHistory(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      const role = req.user?.role;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const history = await RideService.getHistory(userId, role);
      res.json(history);
    } catch (error: any) {
      console.error(`[RIDE] ❌ Error fetching history: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve ride history.' });
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
        res.status(404).json({ error: 'Activity record not found.' });
      }
    } catch (error: any) {
      console.error(`[RIDE] ❌ Delete history error: ${error.message}`);
      res.status(500).json({ error: 'Failed to delete activity record.' });
    }
  }

  /**
   * The user's active trip (any non-terminal status), role-aware. Used by
   * the rider app to hydrate the trip screen when it is opened from a push
   * notification deep link (e.g. "Your driver has arrived" → /trip).
   */
  static async getCurrent(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      const role = req.user?.role;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const activeRole = role === 'DRIVER' ? UserRole.DRIVER : UserRole.RIDER;
      const trip = await RideService.getCurrentRide(userId, activeRole);
      if (!trip) return res.json({ trip: null });
      if (trip.status === 'COMPLETED' || trip.status === 'CANCELLED') {
        return res.json({ trip: null });
      }
      return res.json({ trip });
    } catch (error: any) {
      console.error(`[RIDE] ❌ Get current ride error: ${error.message}`);
      res.status(500).json({ error: 'Failed to load current ride.' });
    }
  }

  /**
   * Idempotent cancel of the rider's current request, by rider identity —
   * no tripId needed. The Flutter client calls this when the rider hits the
   * top-right X / Cancel Ride during "searching", where a race can leave the
   * client without a tripId yet (the socket tripUpdate round-trip). Always
   * returns 200 when there is nothing active to cancel.
   */
  static async cancelCurrentRide(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const trip = await RideService.getCurrentRide(userId, UserRole.RIDER);
      if (!trip) {
        return res.json({ cancelled: false, tripId: null });
      }
      if (trip.status !== 'REQUESTED' && trip.status !== 'ACCEPTED') {
        return res.status(409).json({ error: 'This ride is already in progress and cannot be cancelled.' });
      }
      await RideService.cancelTrip(trip.id, userId, {
        reasonCode: req.body?.reasonCode,
        reasonText: req.body?.reasonText,
      });
      res.json({ cancelled: true, tripId: trip.id });
    } catch (error: any) {
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
  static async getReportStatus(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      const role = req.user?.role;
      const rideId = req.params.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const status = await ReportService.getReportStatus(rideId, userId, role);
      const reporterRole = (role === 'DRIVER' ? 'DRIVER' : 'RIDER') as PartyRole;
      res.json({ ...status, reasons: status.canReport ? REPORT_REASONS[reporterRole] : [] });
    } catch (error: any) {
      console.error(`[RIDE] ❌ Report status error: ${error.message}`);
      res.status(500).json({ error: 'Failed to load report status.' });
    }
  }

  /**
   * File a report against the other ride party. Both parties may report
   * independently — each gets exactly one report per ride.
   */
  static async submitReport(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      const role = req.user?.role;
      const rideId = req.params.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const validatedData = SubmitReportSchema.parse(req.body);
      const report = await ReportService.submitReport(rideId, userId, role, validatedData);
      res.status(201).json(report);
    } catch (error: any) {
      console.error(`[RIDE] ❌ Report submission error: ${error.message}`);
      const status = error?.status ?? 400;
      res.status(status).json({ error: error?.message || 'Failed to submit report.' });
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
  private static async assertTripParty(
    tripId: string,
    userId: string,
    role: string | null,
  ) {
    const res = await pool.query(
      `SELECT id, rider_id, driver_id, status FROM rides WHERE id = $1`,
      [tripId],
    );
    if (res.rows.length === 0) {
      return { ok: false as const, code: 404, error: 'Trip not found.' };
    }
    const trip = res.rows[0];
    if (role != null) {
      const roleLower = role.toLowerCase();
      const isRider = roleLower === 'rider' && trip.rider_id === userId;
      const isDriver = roleLower === 'driver' && trip.driver_id === userId;
      if (!isRider && !isDriver) {
        return { ok: false as const, code: 403, error: 'You are not a party to this trip.' };
      }
    } else {
      // No role provided — accept if the user is either party.
      if (trip.rider_id !== userId && trip.driver_id !== userId) {
        return { ok: false as const, code: 403, error: 'You are not a party to this trip.' };
      }
    }
    return { ok: true as const, trip };
  }

  static async getTripMessages(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      const role = req.user?.role;
      const tripId = req.params.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const party = await RideController.assertTripParty(tripId, userId, role);
      if (!party.ok) return res.status(party.code).json({ error: party.error });

      const sinceRaw = (req.query.since as string | undefined) ?? null;
      const since = sinceRaw ? new Date(sinceRaw) : undefined;
      if (since && Number.isNaN(since.getTime())) {
        return res.status(400).json({ error: 'Invalid `since` timestamp.' });
      }

      const rows = await RideMessagesRepository.listByTrip(tripId, { since });
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
    } catch (error: any) {
      console.error(`[RIDE] ❌ Fetch messages error: ${error.message}`);
      res.status(500).json({ error: 'Unable to fetch messages.' });
    }
  }

  static async mintCallToken(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      const role = req.user?.role;
      const tripId = req.params.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const party = await RideController.assertTripParty(tripId, userId, role);
      if (!party.ok) return res.status(party.code).json({ error: party.error });
      const liveStatuses = [TripStatus.ACCEPTED as string, TripStatus.IN_PROGRESS as string];
      if (!liveStatuses.includes(String(party.trip.status))) {
        return res.status(409).json({ error: 'Calls are only available during an active trip.' });
      }
      if (!TwilioService.isConfigured()) {
        return res.status(503).json({
          error: 'Calls are not enabled in this environment. Please use chat to contact your counterpart.',
        });
      }

      const callToken = TwilioService.mintAccessToken(userId, tripId);
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
        const senderRes = await pool.query('SELECT full_name FROM users WHERE id = $1', [userId]);
        const senderName = senderRes.rows[0]?.full_name || 'Someone';
        await pushIncomingCall(counterpartId, counterpartRole as 'rider' | 'driver', senderName, tripId);
      } catch (pushErr: any) {
        console.error(`[RIDE] ⚠️ Incoming call push failed (non-fatal): ${pushErr.message}`);
      }
    } catch (error: any) {
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
  static async callConnectTwiML(req: any, res: Response) {
    try {
      const tripId = (req.body?.tripId ?? req.query?.tripId) as string | undefined;
      const userId = (req.body?.userId ?? req.query?.userId) as string | undefined;
      if (!tripId || !userId) {
        res.status(400).type('text/xml').send(
          '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Missing call context.</Say></Response>',
        );
        return;
      }
      const party = await RideController.assertTripParty(tripId, userId, null);
      if (!party.ok) {
        res.status(party.code).type('text/xml').send(
          '<?xml version="1.0" encoding="UTF-8"?><Response><Say>You are not authorized for this call.</Say></Response>',
        );
        return;
      }
      const xml = TwilioService.conferenceTwiML(TwilioService.conferenceNameFor(tripId));
      res.type('text/xml').send(xml);
    } catch (error: any) {
      console.error(`[RIDE] ❌ TwiML error: ${error.message}`);
      res.status(500).type('text/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Call setup failed.</Say></Response>',
      );
    }
  }

  /**
   * Webhook for Twilio status callbacks. We log but don't act on them
   * here — billing-side metrics live in the Twilio console. Endpoint
   * exists so Twilio's request signature validation can succeed.
   */
  static async callStatusCallback(req: any, res: Response) {
    try {
      const sid = (req.body?.CallSid as string | undefined) ?? '';
      const status = (req.body?.CallStatus as string | undefined) ?? '';
      console.log(`[CALL] Twilio callback sid=${sid} status=${status}`);
      res.status(204).end();
    } catch (error: any) {
      console.error(`[RIDE] ❌ Call status callback error: ${error.message}`);
      res.status(204).end();
    }
  }
}
