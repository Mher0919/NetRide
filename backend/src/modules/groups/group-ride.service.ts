// backend/src/modules/groups/group-ride.service.ts
//
// Bridges a confirmed group quote/payment set into the EXISTING ride
// lifecycle. A group ride is one normal `rides` row (host = rider_id) so the
// current dispatch, matching, navigation, completion, ratings and tracking
// paths remain authoritative. This service adds the multi-stop driver plan
// and per-passenger pickup confirmation.

import { pool } from '../../config/database';
import { env } from '../../config/env';
import { getIo } from '../../gateway/io-handle';
import { computeEstimate, getConfig } from '../../services/pricing.service';
import { RewardEngine } from '../../services/reward-engine.service';
import { applyPromoToRide } from '../promo/promo.service';
import { LocationsService } from '../location/locations.service';
import { NavigationService } from '../../services/navigation.service';
import { matchQueue } from '../../queue/queue';
import { matchJobsTotal } from '../../observability/metrics';
import { notifyUser, fmtMoney } from '../../services/notification.service';
import { GroupService, GroupError } from './group.service';
import { GroupPaymentsService } from './group-payments.service';
import { GroupRouteService, type GroupPickupPoint } from './group-route.service';
import { dedupePickupStops } from './group-route.optimizer';
import {
  emitGroupPickupConfirmed,
  emitGroupRideUpdated,
  emitGroupUpdated,
  groupMemberIds,
} from './group-events';

interface PlanStop {
  key: string;
  sequence: number;
  lat: number;
  lng: number;
  address: string;
  passengerIds: string[];
  passengers: Array<{ userId: string; name: string }>;
  distanceToDestinationMeters: number;
  durationToDestinationSeconds: number;
}

function stopsFromPlan(planRow: any): PlanStop[] {
  const stops = planRow?.stops?.stops;
  return Array.isArray(stops) ? stops : [];
}

function geometryFromPlan(planRow: any): any {
  return planRow?.stops?.geometry ?? null;
}

export class GroupRideError extends GroupError {}

export class GroupRideService {
  /** Host submits the single group booking after every required share is paid. */
  static async requestRide(groupId: string, hostId: string): Promise<{ rideId: string; idempotent: boolean }> {
    const client = await pool.connect();
    let rideId = '';
    let idempotent = false;
    let quoteIdForLog = '';
    let expiredQuoteId: string | null = null;
    let memberIds: string[] = [];
    let firstStop: { lat: number; lng: number; address: string } | null = null;
    try {
      await client.query('BEGIN');
      const { group } = await GroupService.requireHost(groupId, hostId, client, { forUpdate: true });
      if (group.active_ride_id) {
        const existing = await client.query(`SELECT id, status FROM rides WHERE id = $1`, [group.active_ride_id]);
        const row = existing.rows[0];
        if (row && !['COMPLETED', 'CANCELLED'].includes(row.status)) {
          await client.query('COMMIT');
          return { rideId: row.id, idempotent: true };
        }
      }
      if (!['AWAITING_PAYMENT', 'READY_TO_REQUEST', 'CONFIGURING'].includes(group.status)) {
        throw new GroupRideError('GROUP_NOT_READY', 'This group is not ready to request a ride', 409);
      }
      const quoteRes = await client.query(
        `SELECT * FROM ride_group_quotes WHERE id = $1 AND group_id = $2 FOR UPDATE`,
        [group.current_quote_id, groupId],
      );
      const quote = quoteRes.rows[0];
      if (!quote) throw new GroupRideError('NO_QUOTE', 'Create a fare quote first', 409);
      if (quote.status !== 'ACTIVE') {
        throw new GroupRideError('QUOTE_STALE', 'The fare quote is no longer current. Refresh it.', 409);
      }
      if (new Date(quote.expires_at).getTime() <= Date.now()) {
        expiredQuoteId = quote.id;
        throw new GroupRideError('QUOTE_EXPIRED', 'The fare quote expired. Refresh it and confirm again.', 409);
      }
      quoteIdForLog = quote.id;

      const payRes = await client.query(
        `SELECT * FROM ride_group_payments WHERE quote_id = $1 FOR UPDATE`,
        [quote.id],
      );
      const required = payRes.rows.filter((r: any) => Number(r.amount_cents) > 0);
      if (required.length > 0 && !required.every((r: any) => r.status === 'SUCCEEDED')) {
        throw new GroupRideError(
          'PAYMENTS_INCOMPLETE',
          'Every participant must confirm their share before the ride can be requested.',
          409,
        );
      }
      if (payRes.rows.some((r: any) => r.status === 'PROCESSING')) {
        throw new GroupRideError('PAYMENTS_PROCESSING', 'A participant payment is still processing. Try again shortly.', 409);
      }

      const memberRes = await client.query(
        `SELECT m.user_id, m.status, m.pickup_lat, m.pickup_lng, m.pickup_address,
                m.pickup_place_id, u.full_name, u.rating
           FROM ride_group_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.group_id = $1
            AND m.status IN ('JOINED','PICKUP_PENDING','PICKUP_CONFIRMED')
          ORDER BY CASE WHEN m.user_id = $2::uuid THEN 0 ELSE 1 END, m.joined_at ASC`,
        [groupId, hostId],
      );
      memberIds = memberRes.rows.map((r: any) => r.user_id);
      if (memberIds.length !== memberRes.rows.length || memberIds.length === 0) {
        throw new GroupRideError('NO_PARTICIPANTS', 'The group has no active participants', 409);
      }
      const hostMember = memberRes.rows.find((r: any) => r.user_id === hostId);
      if (!hostMember) throw new GroupRideError('HOST_MISSING', 'The host is not an active participant', 409);

      const busyParticipant = await client.query(
        `SELECT rider_id FROM rides
          WHERE rider_id = ANY($1::uuid[])
            AND status NOT IN ('COMPLETED','CANCELLED')
          LIMIT 1`,
        [memberIds],
      );
      if (busyParticipant.rows[0]) {
        throw new GroupRideError(
          'PARTICIPANT_ACTIVE_RIDE',
          'A participant already has another active ride. Ask them to finish or cancel it first.',
          409,
        );
      }

      const planRes = await client.query(
        `SELECT * FROM ride_group_route_plans WHERE id = $1`,
        [quote.route_plan_id],
      );
      const plan = planRes.rows[0];
      if (!plan) throw new GroupRideError('ROUTE_MISSING', 'The optimized route is missing. Refresh the quote.', 409);
      const stops = stopsFromPlan(plan);
      if (stops.length === 0) throw new GroupRideError('ROUTE_MISSING', 'The optimized route is missing.', 409);
      firstStop = { lat: stops[0].lat, lng: stops[0].lng, address: stops[0].address };

      // Reject if the host already has another live ride.
      const active = await client.query(
        `SELECT id FROM rides
          WHERE rider_id = $1 AND status NOT IN ('COMPLETED','CANCELLED')
            AND group_id IS DISTINCT FROM $2::uuid
          LIMIT 1`,
        [hostId, groupId],
      );
      if (active.rows[0]) {
        throw new GroupRideError('ACTIVE_RIDE_EXISTS', 'You already have an active ride.', 409);
      }

      const originalFareCents = Number(quote.original_fare_cents);
      const discountedTotalCents = Number(quote.discounted_total_cents);
      const creditCents = payRes.rows.reduce((sum: number, r: any) => sum + Number(r.credit_cents ?? 0), 0);
      const cardCents = payRes.rows.reduce((sum: number, r: any) => sum + Number(r.card_cents ?? 0), 0);
      const finalPaymentCents = Math.max(0, discountedTotalCents - creditCents);
      if (cardCents !== finalPaymentCents) {
        throw new GroupRideError('PAYMENT_MISMATCH', 'Participant payment totals do not reconcile with the quote', 409);
      }

      const idempotencyKey = `group:${groupId}:${quote.id}`;
      const insert = await client.query(
        `INSERT INTO rides (
           rider_id, status, pickup_lat, pickup_lng, pickup_address,
           destination_lat, destination_lng, destination_address,
           requested_class, snapshot_rider_rating, distance_meters, duration_seconds,
           fare_amount, final_payment_cents, credits_applied_cents,
           wallet_payment_cents, promo_discount_cents, promo_code,
           idempotency_key, group_id, is_scheduled
         ) VALUES (
           $1,'REQUESTED',$2,$3,$4,$5,$6,$7,'CORE',$8,$9,$10,$11,$12,$13,0,$14,$15,$16,$17,FALSE
         ) RETURNING id`,
        [
          hostId,
          firstStop.lat,
          firstStop.lng,
          firstStop.address,
          Number(group.destination_lat),
          Number(group.destination_lng),
          group.destination_address,
          Number(hostMember.rating ?? 5),
          Math.round(Number(plan.total_distance_meters ?? 0)),
          Math.round(Number(plan.total_duration_seconds ?? 0)),
          originalFareCents / 100,
          finalPaymentCents,
          creditCents,
          Number(quote.promo_discount_cents ?? 0),
          quote.promo_code ?? null,
          idempotencyKey,
          groupId,
        ],
      );
      rideId = insert.rows[0].id;

      // Apply the promo exactly ONCE against the whole group booking, with
      // the same authoritative code engine used by regular rides. The quote
      // already froze the discount; a mismatch means the promo changed and
      // the booking must not proceed silently at a different price.
      if (quote.promo_code) {
        const promo = await applyPromoToRide(
          client,
          hostId,
          rideId,
          quote.promo_code,
          originalFareCents,
        );
        if (promo.discountCents !== Number(quote.promo_discount_cents)) {
          throw new GroupRideError(
            'QUOTE_STALE',
            'The promo code changed since this quote was created. Refresh the quote.',
            409,
          );
        }
        await client.query(
          `UPDATE rides SET promo_id = $2, promo_code = $3, promo_discount_cents = $4 WHERE id = $1`,
          [rideId, promo.promo.id, promo.promo.code, promo.discountCents],
        );
      }

      // Freeze the quote price into the standard ride price snapshot. Do not
      // recompute from live pricing: the quote is the price the participants
      // already paid.
      const fare = quote.fare_components?.fare ?? {};
      const config = await getConfig('PREMIUM', true);
      await client.query(
        `INSERT INTO ride_price_snapshots
           (ride_id, distance_km, duration_minutes, multiplier_breakdown, config, final_fare)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
         ON CONFLICT (ride_id) DO NOTHING`,
        [
          rideId,
          Number(plan.total_distance_meters ?? 0) / 1000,
          Number(plan.total_duration_seconds ?? 0) / 60,
          JSON.stringify(fare.multiplierBreakdown ?? {}),
          JSON.stringify(config),
          originalFareCents / 100,
        ],
      );

      // A booking-phase plan ties the immutable estimate snapshot to the ride.
      const newPlan = await GroupRouteService.persist(client, {
        groupId,
        rideId,
        phase: 'BOOKING',
        plan: {
          stops,
          totalDistanceMeters: Number(plan.total_distance_meters ?? 0),
          totalDurationSeconds: Number(plan.total_duration_seconds ?? 0),
          geometry: geometryFromPlan(plan) ?? { type: 'LineString', coordinates: [] },
          engine: plan.engine ?? 'GoogleRoutes',
          start: {
            lat: Number(plan.origin_lat ?? stops[0].lat),
            lng: Number(plan.origin_lng ?? stops[0].lng),
          },
          destination: {
            lat: Number(group.destination_lat),
            lng: Number(group.destination_lng),
            address: group.destination_address ?? '',
          },
          orderedStopKeys: stops.map((s) => s.key),
        },
      });
      void newPlan;

      await client.query(
        `UPDATE ride_group_quotes SET status = 'CONSUMED' WHERE id = $1`,
        [quote.id],
      );
      await client.query(
        `UPDATE ride_groups
            SET active_ride_id = $2, status = 'DRIVER_MATCHING', locked_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [groupId, rideId],
      );
      await GroupService.recordSystemMessage(
        client,
        groupId,
        `The host requested the group ride (${fmtMoney(originalFareCents)} total).`,
        { rideId },
        'RIDE',
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      if ((err as any)?.code === '23505') {
        // Concurrent request won the unique group idempotency key.
        const existing = await pool.query(
          `SELECT active_ride_id FROM ride_groups WHERE id = $1`,
          [groupId],
        );
        if (existing.rows[0]?.active_ride_id) {
          return { rideId: existing.rows[0].active_ride_id, idempotent: true };
        }
      }
      if (expiredQuoteId) {
        await pool.query(
          `UPDATE ride_group_quotes SET status = 'EXPIRED' WHERE id = $1 AND status = 'ACTIVE'`,
          [expiredQuoteId],
        ).catch(() => undefined);
        await GroupPaymentsService.refundQuotePayments(expiredQuoteId, 'quote expired').catch(() => undefined);
      }
      throw err;
    } finally {
      client.release();
    }

    // Existing dispatch pipeline is the only matcher. No parallel queue.
    const pickup = firstStop!;
    const isNow = true;
    if (isNow) {
      if (env.LEGACY_SYNC_MATCHING) {
        import('../../services/matching.service')
          .then(({ matchingService }) =>
            matchingService
              .findAndDispatch(getIo(), rideId, pickup.lat, pickup.lng, hostId, false)
              .catch((err: any) => console.error('[GROUP] in-process dispatch failed:', err.message)),
          )
          .catch(() => undefined);
      } else {
        matchQueue
          .add('matchRide', {
            tripId: rideId,
            pickupLat: pickup.lat,
            pickupLng: pickup.lng,
            riderId: hostId,
            favoritePriority: false,
          })
          .catch((err) => console.error('[GROUP] enqueue match failed:', err.message));
        matchJobsTotal.inc({ outcome: 'enqueued' });
      }
    }
    RewardEngine.onRideRequested({
      id: rideId,
      rider_id: hostId,
      driver_id: null,
      fare_amount: null,
      status: 'REQUESTED',
    }).catch(() => undefined);

    await emitGroupUpdated(groupId, { rideId, status: 'DRIVER_MATCHING' });
    for (const userId of memberIds) {
      await notifyUser({
        userId,
        role: 'rider',
        type: 'group_ride',
        title: 'Group ride requested',
        body: 'Your group ride is now looking for a driver.',
        data: { groupId, rideId, route: '/groups' },
        eventId: `group-ride-requested:${rideId}:${userId}`,
      }).catch(() => undefined);
    }
    void quoteIdForLog;
    return { rideId, idempotent };
  }

  /**
   * Driver accepted the group booking. Re-optimize using the driver's actual
   * location and persist the authoritative DRIVER plan. Called from
   * RideService.acceptTrip inside the same accept flow.
   */
  static async onDriverAssigned(
    rideId: string,
    driverId: string,
    driverLocation: { lat: number; lng: number } | null,
  ): Promise<void> {
    const groupRes = await pool.query(
      `SELECT g.* FROM ride_groups g JOIN rides r ON r.group_id = g.id WHERE r.id = $1`,
      [rideId],
    );
    const group = groupRes.rows[0];
    if (!group) return;
    const memberRes = await pool.query(
      `SELECT m.*, u.full_name FROM ride_group_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.group_id = $1
          AND m.status IN ('JOINED','PICKUP_PENDING','PICKUP_CONFIRMED','PICKED_UP')
        ORDER BY CASE WHEN m.user_id = $2::uuid THEN 0 ELSE 1 END, m.joined_at ASC`,
      [group.id, group.host_id],
    );
    const pickups: GroupPickupPoint[] = memberRes.rows
      .filter((row: any) => row.pickup_lat != null && row.pickup_lng != null)
      .map((row: any) => ({
        userId: row.user_id,
        name: row.full_name,
        lat: Number(row.pickup_lat),
        lng: Number(row.pickup_lng),
        address: row.pickup_address ?? '',
        placeId: row.pickup_place_id ?? null,
      }));
    if (pickups.length === 0) return;
    const start = driverLocation ?? {
      lat: Number(pickups[0].lat),
      lng: Number(pickups[0].lng),
    };
    let plan;
    try {
      plan = await GroupRouteService.plan({
        start,
        pickups,
        destination: {
          lat: Number(group.destination_lat),
          lng: Number(group.destination_lng),
          address: group.destination_address ?? '',
        },
      });
    } catch (err: any) {
      console.error(`[GROUP] driver-plan optimization failed for ${rideId}: ${err.message}`);
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT id FROM ride_groups WHERE id = $1 FOR UPDATE`, [group.id]);
      // A new driver starts the pickup flow from scratch.
      await client.query(
        `UPDATE ride_group_members
            SET status = 'JOINED', picked_up_at = NULL, updated_at = NOW()
          WHERE group_id = $1 AND status = 'PICKED_UP'`,
        [group.id],
      );
      const persisted = await GroupRouteService.persist(client, {
        groupId: group.id,
        rideId,
        phase: 'DRIVER',
        plan,
      });
      const first = plan.stops[0];
      await client.query(
        `UPDATE rides
            SET pickup_lat = $2, pickup_lng = $3, pickup_address = $4,
                distance_meters = $5, duration_seconds = $6, updated_at = NOW()
          WHERE id = $1`,
        [
          rideId,
          first.lat,
          first.lng,
          first.address,
          Math.round(plan.totalDistanceMeters),
          Math.round(plan.totalDurationSeconds),
        ],
      );
      await client.query(
        `UPDATE ride_groups SET status = 'DRIVER_ASSIGNED', updated_at = NOW()
          WHERE id = $1 AND status IN ('RIDE_REQUESTED','DRIVER_MATCHING','DRIVER_ASSIGNED')`,
        [group.id],
      );
      const driver = await client.query(`SELECT full_name FROM users WHERE id = $1`, [driverId]);
      await GroupService.recordSystemMessage(
        client,
        group.id,
        `${driver.rows[0]?.full_name ?? 'Your driver'} accepted the group ride.`,
        { rideId, driverId, planId: persisted.id, planVersion: persisted.version },
        'RIDE',
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }

    try {
      const pickupRoute = await NavigationService.cacheRouteLeg(
        rideId,
        'pickup',
        [start.lat, start.lng],
        [plan.stops[0].lat, plan.stops[0].lng],
      );
      NavigationService.emitStarted(getIo(), rideId, driverId, group.host_id, 'pickup', pickupRoute);
    } catch (err: any) {
      console.error(`[GROUP] navigation start failed: ${err.message}`);
    }
    await GroupService.broadcastGroupRide(group.id, {
      event: 'DRIVER_ASSIGNED',
      rideId,
      driverId,
    });
    for (const userId of await groupMemberIds(group.id)) {
      await notifyUser({
        userId,
        role: 'rider',
        type: 'group_ride',
        title: 'Driver assigned',
        body: 'Your group ride is on the way. Track the driver in the group.',
        data: { groupId: group.id, rideId, route: '/groups' },
        eventId: `group-driver-assigned:${rideId}:${userId}`,
      }).catch(() => undefined);
    }
  }

  /** Driver marks one passenger as picked up at the current stop. */
  static async confirmParticipantPickup(
    rideId: string,
    driverId: string,
    participantId: string,
  ): Promise<{ rideId: string; status: string; completedStops: number; totalStops: number }> {
    return this.resolvePickupOutcome(rideId, driverId, participantId, 'PICKED_UP');
  }

  /**
   * Driver marks a passenger as a no-show. This is NOT a financial penalty
   * invented by us: the platform has no group no-show fee, so the prepaid
   * share is kept and the stop is resolved so the group can continue.
   */
  static async markParticipantNoShow(
    rideId: string,
    driverId: string,
    participantId: string,
  ): Promise<{ rideId: string; status: string; completedStops: number; totalStops: number }> {
    return this.resolvePickupOutcome(rideId, driverId, participantId, 'NO_SHOW');
  }

  private static async resolvePickupOutcome(
    rideId: string,
    driverId: string,
    participantId: string,
    outcome: 'PICKED_UP' | 'NO_SHOW',
  ): Promise<{ rideId: string; status: string; completedStops: number; totalStops: number }> {
    const rideRes = await pool.query(`SELECT * FROM rides WHERE id = $1`, [rideId]);
    const ride = rideRes.rows[0];
    if (!ride || !ride.group_id) throw new GroupRideError('NOT_GROUP_RIDE', 'This is not a group ride', 404);
    if (ride.driver_id !== driverId) throw new GroupRideError('FORBIDDEN', 'You are not the assigned driver', 403);
    if (!['ACCEPTED', 'DRIVER_ARRIVING'].includes(ride.status)) {
      throw new GroupRideError('INVALID_STATE', 'Pickups can only be confirmed before the trip starts', 409);
    }
    const planRow = await GroupRouteService.loadDriverPlanForRide(rideId);
    if (!planRow) throw new GroupRideError('ROUTE_MISSING', 'The driver route plan is missing', 409);
    const stops = stopsFromPlan(planRow);
    const membersRes = await pool.query(
      `SELECT user_id, status, picked_up_at, full_name FROM ride_group_members WHERE group_id = $1`,
      [ride.group_id],
    );
    const memberById = new Map(membersRes.rows.map((r: any) => [r.user_id, r]));
    const resolvedStatuses = new Set(['PICKED_UP', 'NO_SHOW']);
    const currentIndex = stops.findIndex((stop) =>
      stop.passengerIds.some((id) => !resolvedStatuses.has(memberById.get(id)?.status)),
    );
    if (currentIndex < 0) {
      // Recovery path: all passengers were confirmed but a crash/network
      // failure prevented the ride from flipping to IN_PROGRESS. Retrying any
      // pickup must complete the transition instead of trapping the driver.
      await this.startTripIfReady(rideId, ride.group_id, driverId);
      return this.pickupState(rideId, ride.group_id);
    }
    const current = stops[currentIndex];
    if (!current.passengerIds.includes(participantId)) {
      throw new GroupRideError('WRONG_STOP', 'That passenger is not at the current pickup stop', 409);
    }
    const participant = memberById.get(participantId);
    if (!participant) throw new GroupRideError('PARTICIPANT_NOT_FOUND', 'Passenger not found', 404);
    if (resolvedStatuses.has(participant.status)) {
      return this.pickupState(rideId, ride.group_id);
    }

    const driverLoc = await LocationsService.getDriverLocation(driverId).catch(() => null);
    if (driverLoc) {
      const { haversineMeters } = await import('../../services/route-store.service');
      const distance = haversineMeters(
        [driverLoc.lat, driverLoc.lng],
        [current.lat, current.lng],
      );
      // GPS accuracy + parking variance: allow a slightly wider pickup radius
      // than the platform default, but never confirm a passenger from across
      // town. The exact number is configurable via DRIVER_PICKUP_PROXIMITY_M.
      const allowed = Math.max(150, env.DRIVER_PICKUP_PROXIMITY_M + 100);
      if (distance > allowed) {
        throw new GroupRideError(
          'TOO_FAR_FROM_PICKUP',
          `Move closer to the pickup point to confirm this passenger (${Math.round(distance)} m away).`,
          409,
        );
      }
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT id FROM ride_groups WHERE id = $1 FOR UPDATE`, [ride.group_id]);
      const update = await client.query(
        `UPDATE ride_group_members
            SET status = $3,
                picked_up_at = CASE WHEN $3 = 'PICKED_UP' THEN NOW() ELSE picked_up_at END,
                updated_at = NOW()
          WHERE group_id = $1 AND user_id = $2
            AND status IN ('JOINED','PICKUP_PENDING','PICKUP_CONFIRMED')`,
        [ride.group_id, participantId, outcome],
      );
      if ((update.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return this.pickupState(rideId, ride.group_id);
      }
      await GroupService.recordSystemMessage(
        client,
        ride.group_id,
        outcome === 'PICKED_UP'
          ? `${participant.full_name} was picked up.`
          : `${participant.full_name} was marked as a no-show.`,
        { rideId, userId: participantId, stopSequence: current.sequence, outcome },
        'PICKUP',
      );

      const after = await client.query(
        `SELECT user_id, status FROM ride_group_members WHERE group_id = $1`,
        [ride.group_id],
      );
      const statusById = new Map(after.rows.map((r: any) => [r.user_id, r.status]));
      const stopDone = current.passengerIds.every((id) =>
        resolvedStatuses.has(statusById.get(id)),
      );
      let tripStarted = false;
      if (stopDone) {
        const remainingStops = stops.filter((stop, idx) =>
          idx > currentIndex &&
          stop.passengerIds.some((id) => !resolvedStatuses.has(statusById.get(id))),
        );
        if (remainingStops.length === 0) {
          tripStarted = true;
        } else {
          // Re-optimize only the remaining pickups from the driver's actual
          // position. The destination stays fixed and the completed stop is
          // never reintroduced.
          const remainingPickups: GroupPickupPoint[] = [];
          for (const stop of remainingStops) {
            for (const id of stop.passengerIds) {
              const row = await client.query(
                `SELECT m.user_id, m.pickup_lat, m.pickup_lng, m.pickup_address, m.pickup_place_id, u.full_name
                   FROM ride_group_members m JOIN users u ON u.id = m.user_id
                  WHERE m.group_id = $1 AND m.user_id = $2`,
                [ride.group_id, id],
              );
              const p = row.rows[0];
              if (p && p.pickup_lat != null) {
                remainingPickups.push({
                  userId: p.user_id,
                  name: p.full_name,
                  lat: Number(p.pickup_lat),
                  lng: Number(p.pickup_lng),
                  address: p.pickup_address ?? '',
                  placeId: p.pickup_place_id ?? null,
                });
              }
            }
          }
          try {
            const replanned = await GroupRouteService.plan({
              start: driverLoc ?? { lat: current.lat, lng: current.lng },
              pickups: remainingPickups,
              destination: {
                lat: Number(ride.destination_lat),
                lng: Number(ride.destination_lng),
                address: ride.destination_address ?? '',
              },
            });
            await GroupRouteService.persist(client, {
              groupId: ride.group_id,
              rideId,
              phase: 'DRIVER',
              plan: replanned,
            });
            await client.query(
              `UPDATE rides
                  SET pickup_lat = $2, pickup_lng = $3, pickup_address = $4,
                      distance_meters = $5, duration_seconds = $6, updated_at = NOW()
                WHERE id = $1`,
              [
                rideId,
                replanned.stops[0].lat,
                replanned.stops[0].lng,
                replanned.stops[0].address,
                Math.round(replanned.totalDistanceMeters),
                Math.round(replanned.totalDurationSeconds),
              ],
            );
          } catch (err: any) {
            console.error(`[GROUP] remaining-stop replan failed: ${err.message}`);
          }
        }
      }
      await client.query('COMMIT');

      if (tripStarted) {
        const { RideService } = await import('../ride/ride.service');
        await RideService.updateTripStatus(rideId, 'IN_PROGRESS', driverId);
        await pool.query(
          `UPDATE ride_groups SET status = 'IN_PROGRESS', updated_at = NOW() WHERE id = $1`,
          [ride.group_id],
        );
      }
      await emitGroupPickupConfirmed(ride.group_id, {
        rideId,
        participantId,
        stopSequence: current.sequence,
        tripStarted,
      });
      await GroupService.broadcastGroupRide(ride.group_id, {
        event: 'PICKUP_CONFIRMED',
        rideId,
        participantId,
        tripStarted,
      });
      if (tripStarted) {
        await GroupService.recordSystemMessage(
          pool,
          ride.group_id,
          'Everyone is on board. The trip is now heading to the destination.',
          { rideId },
          'RIDE',
        );
      }
      const state = await this.pickupState(rideId, ride.group_id);
      return state;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  }

  private static async startTripIfReady(
    rideId: string,
    groupId: string,
    driverId: string,
  ): Promise<void> {
    const ride = await pool.query(`SELECT status FROM rides WHERE id = $1`, [rideId]);
    const status = ride.rows[0]?.status;
    if (status !== 'ACCEPTED' && status !== 'DRIVER_ARRIVING') return;
    const { RideService } = await import('../ride/ride.service');
    await RideService.updateTripStatus(rideId, 'IN_PROGRESS', driverId);
    await pool.query(
      `UPDATE ride_groups SET status = 'IN_PROGRESS', updated_at = NOW()
        WHERE id = $1 AND status IN ('DRIVER_ASSIGNED','DRIVER_MATCHING','RIDE_REQUESTED')`,
      [groupId],
    );
  }

  private static async pickupState(
    rideId: string,
    groupId: string,
  ): Promise<{ rideId: string; status: string; completedStops: number; totalStops: number }> {
    const ride = await pool.query(`SELECT status FROM rides WHERE id = $1`, [rideId]);
    const plan = await GroupRouteService.loadDriverPlanForRide(rideId);
    const stops = stopsFromPlan(plan);
    const members = await pool.query(
      `SELECT user_id, status FROM ride_group_members WHERE group_id = $1`,
      [groupId],
    );
    const statusById = new Map(members.rows.map((r: any) => [r.user_id, r.status]));
    const completedStops = stops.filter((s) =>
      s.passengerIds.length > 0 &&
      s.passengerIds.every((id) => ['PICKED_UP', 'NO_SHOW'].includes(statusById.get(id))),
    ).length;
    return {
      rideId,
      status: ride.rows[0]?.status ?? 'ACCEPTED',
      completedStops,
      totalStops: stops.length,
    };
  }

  /**
   * Re-optimize the REMAINING pickups from the driver's current GPS position.
   * Called opportunistically (throttled by the socket gateway) so traffic /
   * drift can update the authoritative stop order before the next pickup.
   * Never reorders a completed stop and never moves the fixed destination.
   */
  static async replanRemaining(rideId: string, driverId: string): Promise<boolean> {
    const rideRes = await pool.query(`SELECT * FROM rides WHERE id = $1`, [rideId]);
    const ride = rideRes.rows[0];
    if (!ride || !ride.group_id || ride.driver_id !== driverId) return false;
    if (!['ACCEPTED', 'DRIVER_ARRIVING'].includes(ride.status)) return false;
    const memberRes = await pool.query(
      `SELECT m.*, u.full_name
         FROM ride_group_members m JOIN users u ON u.id = m.user_id
        WHERE m.group_id = $1
          AND m.status IN ('JOINED','PICKUP_PENDING','PICKUP_CONFIRMED')
          AND m.pickup_lat IS NOT NULL AND m.pickup_lng IS NOT NULL`,
      [ride.group_id],
    );
    if (memberRes.rows.length === 0) return false;
    const driverLoc = await LocationsService.getDriverLocation(driverId).catch(() => null);
    if (!driverLoc) return false;
    let plan;
    try {
      plan = await GroupRouteService.plan({
        start: driverLoc,
        pickups: memberRes.rows.map((row: any) => ({
          userId: row.user_id,
          name: row.full_name,
          lat: Number(row.pickup_lat),
          lng: Number(row.pickup_lng),
          address: row.pickup_address ?? '',
          placeId: row.pickup_place_id ?? null,
        })),
        destination: {
          lat: Number(ride.destination_lat),
          lng: Number(ride.destination_lng),
          address: ride.destination_address ?? '',
        },
      });
    } catch {
      return false;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT id FROM ride_groups WHERE id = $1 FOR UPDATE`, [ride.group_id]);
      const liveMembers = await client.query(
        `SELECT user_id, status FROM ride_group_members
          WHERE group_id = $1
            AND status IN ('JOINED','PICKUP_PENDING','PICKUP_CONFIRMED')`,
        [ride.group_id],
      );
      const liveIds = new Set(liveMembers.rows.map((r: any) => r.user_id));
      const plannedIds = plan.stops.flatMap((s) => s.passengerIds);
      if (plannedIds.some((id) => !liveIds.has(id))) {
        // A passenger was picked up / left while the matrix was computed.
        // Never reintroduce a completed stop.
        await client.query('ROLLBACK');
        return false;
      }
      await GroupRouteService.persist(client, {
        groupId: ride.group_id,
        rideId,
        phase: 'DRIVER',
        plan,
      });
      await client.query(
        `UPDATE rides
            SET pickup_lat = $2, pickup_lng = $3, pickup_address = $4,
                distance_meters = $5, duration_seconds = $6, updated_at = NOW()
          WHERE id = $1`,
        [
          rideId,
          plan.stops[0].lat,
          plan.stops[0].lng,
          plan.stops[0].address,
          Math.round(plan.totalDistanceMeters),
          Math.round(plan.totalDurationSeconds),
        ],
      );
      await client.query('COMMIT');
    } catch {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      return false;
    } finally {
      client.release();
    }
    try {
      const pickupRoute = await NavigationService.cacheRouteLeg(
        rideId,
        'pickup',
        [driverLoc.lat, driverLoc.lng],
        [plan.stops[0].lat, plan.stops[0].lng],
      );
      NavigationService.emitStarted(getIo(), rideId, driverId, ride.host_id, 'pickup', pickupRoute);
    } catch { /* best effort */ }
    await GroupService.broadcastGroupRide(ride.group_id, {
      event: 'ROUTE_UPDATED',
      rideId,
    });
    return true;
  }

  /** Driver-facing authoritative route + passenger pickup state. */
  static async getDriverRideView(rideId: string, driverId: string): Promise<Record<string, any>> {
    const res = await pool.query(
      `SELECT r.*, g.name AS group_name, g.status AS group_status
         FROM rides r JOIN ride_groups g ON g.id = r.group_id
        WHERE r.id = $1`,
      [rideId],
    );
    const ride = res.rows[0];
    if (!ride) throw new GroupRideError('RIDE_NOT_FOUND', 'Ride not found', 404);
    if (ride.driver_id !== driverId) throw new GroupRideError('FORBIDDEN', 'Not your ride', 403);
    const plan = await GroupRouteService.loadDriverPlanForRide(rideId);
    const memberRes = await pool.query(
      `SELECT user_id, status, picked_up_at FROM ride_group_members WHERE group_id = $1`,
      [ride.group_id],
    );
    const statusById = new Map(memberRes.rows.map((r: any) => [r.user_id, r]));
    const stops = stopsFromPlan(plan).map((stop) => {
      const passengers = stop.passengers.map((p) => ({
        userId: p.userId,
        name: p.name,
        status: statusById.get(p.userId)?.status ?? 'JOINED',
        pickedUpAt: statusById.get(p.userId)?.picked_up_at ?? null,
      }));
      return {
        ...stop,
        passengers,
        completed: passengers.every((p) =>
          ['PICKED_UP', 'COMPLETED', 'NO_SHOW'].includes(p.status),
        ),
      };
    });
    const currentStopIndex = stops.findIndex((s) => !s.completed);
    let driverLocation: any = null;
    try {
      driverLocation = await LocationsService.getDriverLocation(driverId);
    } catch { /* optional */ }
    let geometry = geometryFromPlan(plan);
    let totalDistanceMeters = Number(plan?.total_distance_meters ?? 0);
    let totalDurationSeconds = Number(plan?.total_duration_seconds ?? 0);
    if (ride.status === 'IN_PROGRESS') {
      // Reuse the existing navigation leg to the destination once every
      // passenger is on board; it reflects the driver's actual position and
      // any reroutes handled by the regular navigation pipeline.
      try {
        const live = await NavigationService.getCachedRouteLeg(rideId, 'destination');
        if (live && live.geometry.coordinates.length >= 2) {
          geometry = live.geometry;
          totalDistanceMeters = live.distance ?? totalDistanceMeters;
          totalDurationSeconds = live.duration ?? totalDurationSeconds;
        }
      } catch { /* fall back to the plan */ }
    }
    return {
      rideId,
      groupId: ride.group_id,
      groupName: ride.group_name,
      groupStatus: ride.group_status,
      rideStatus: ride.status,
      stops,
      currentStopIndex: currentStopIndex < 0 ? stops.length : currentStopIndex,
      destination: {
        lat: Number(ride.destination_lat),
        lng: Number(ride.destination_lng),
        address: ride.destination_address ?? '',
      },
      geometry,
      totalDistanceMeters,
      totalDurationSeconds,
      driverLocation,
      allPickedUp: currentStopIndex < 0,
    };
  }

  /** Completion hook: synchronize all participants and close the group. */
  static async onRideCompleted(rideId: string): Promise<void> {
    const res = await pool.query(
      `SELECT r.group_id, g.name FROM rides r JOIN ride_groups g ON g.id = r.group_id WHERE r.id = $1`,
      [rideId],
    );
    const row = res.rows[0];
    if (!row) return;
    const client = await pool.connect();
    let memberIds: string[] = [];
    try {
      await client.query('BEGIN');
      const group = await client.query(
        `SELECT status FROM ride_groups WHERE id = $1 FOR UPDATE`,
        [row.group_id],
      );
      if (!group.rows[0] || ['COMPLETED', 'CANCELLED'].includes(group.rows[0].status)) {
        await client.query('COMMIT');
        return;
      }
      await client.query(
        `UPDATE ride_group_members
            SET status = CASE WHEN status = 'PICKED_UP' THEN 'COMPLETED' ELSE status END,
                updated_at = NOW()
          WHERE group_id = $1 AND status IN ('PICKED_UP','COMPLETED')`,
        [row.group_id],
      );
      await client.query(
        `UPDATE ride_groups SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1`,
        [row.group_id],
      );
      await GroupService.recordSystemMessage(
        client,
        row.group_id,
        'The group ride was completed. Thanks for riding with NetRide!',
        { rideId },
        'RIDE',
      );
      const members = await client.query(
        `SELECT user_id FROM ride_group_members
          WHERE group_id = $1 AND status = 'COMPLETED'`,
        [row.group_id],
      );
      memberIds = members.rows.map((r: any) => r.user_id);
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
    await emitGroupUpdated(row.group_id, { rideId, completed: true });
    await GroupService.broadcastGroupRide(row.group_id, { event: 'COMPLETED', rideId });
    for (const userId of memberIds) {
      await notifyUser({
        userId,
        role: 'rider',
        type: 'group_ride',
        title: 'Group ride completed',
        body: 'Rate your driver and add them to your favorites.',
        data: { groupId: row.group_id, rideId, route: '/groups' },
        eventId: `group-ride-completed:${rideId}:${userId}`,
      }).catch(() => undefined);
    }
  }

  /** Cancellation hook: refund every participant and close the group. */
  static async onRideCancelled(rideId: string, reason: string): Promise<void> {
    const res = await pool.query(
      `SELECT group_id FROM rides WHERE id = $1`,
      [rideId],
    );
    const groupId = res.rows[0]?.group_id;
    if (!groupId) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const group = await client.query(
        `SELECT status FROM ride_groups WHERE id = $1 FOR UPDATE`,
        [groupId],
      );
      if (group.rows[0] && !['COMPLETED', 'CANCELLED'].includes(group.rows[0].status)) {
        await client.query(
          `UPDATE ride_groups SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1`,
          [groupId],
        );
        await client.query(
          `UPDATE ride_group_members
              SET status = 'CANCELLED', updated_at = NOW()
            WHERE group_id = $1
              AND status IN ('PICKED_UP','JOINED','PICKUP_PENDING','PICKUP_CONFIRMED')`,
          [groupId],
        );
        await GroupService.recordSystemMessage(
          client,
          groupId,
          `The group ride was cancelled${reason ? `: ${reason}` : ''}. Payments are being refunded.`,
          { rideId },
          'RIDE',
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
    await GroupPaymentsService.refundGroupPaymentsForRide(rideId, reason || 'group ride cancelled');
    await emitGroupUpdated(groupId, { rideId, cancelled: true });
    await GroupService.broadcastGroupRide(groupId, { event: 'CANCELLED', rideId });
    for (const userId of await groupMemberIds(groupId)) {
      await notifyUser({
        userId,
        role: 'rider',
        type: 'group_ride',
        title: 'Group ride cancelled',
        body: 'The group ride was cancelled. Your share is being refunded.',
        data: { groupId, rideId, route: '/groups' },
        eventId: `group-ride-cancelled:${rideId}:${userId}`,
      }).catch(() => undefined);
    }
  }

  /** Used by the quote preview endpoint to avoid recomputing a route. */
  static stopCount(plan: any): number {
    return stopsFromPlan(plan).length;
  }

  static totalDistance(plan: any): number {
    return Number(plan?.total_distance_meters ?? 0);
  }

  static totalDuration(plan: any): number {
    return Number(plan?.total_duration_seconds ?? 0);
  }

  static estimateForRoute(distanceMeters: number, durationSeconds: number): number {
    return Math.round(computeEstimate({ distanceMeters, durationSeconds }).totalFare * 100);
  }

  static groupStopsDeduped(pickups: Array<{ passengerId: string; lat: number; lng: number }>) {
    return dedupePickupStops(pickups);
  }
}
