// backend/src/modules/groups/group-route.service.ts
//
// Global multi-pickup route planning for group rides.
//
// The optimizer (group-route.optimizer.ts) chooses the authoritative pickup
// order from a complete road-cost matrix. This service is the I/O boundary:
// it loads group pickups, builds the matrix through RoutingService, dedupes
// physical stops, produces the continuous route geometry and persists
// versioned immutable route plans.

import { pool } from '../../config/database';
import { RoutingService } from '../routing/routing.service';
import {
  dedupePickupStops,
  matrixKey,
  optimizeStopOrder,
  type MatrixCell,
} from './group-route.optimizer';

export type GroupRoutePhase = 'ESTIMATE' | 'BOOKING' | 'DRIVER';

export interface GroupPickupPoint {
  userId: string;
  name: string;
  lat: number;
  lng: number;
  address: string;
  placeId?: string | null;
}

export interface PlannedStop {
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

export interface GroupRoutePlanResult {
  stops: PlannedStop[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
  engine: string;
  start: { lat: number; lng: number };
  destination: { lat: number; lng: number; address: string };
  orderedStopKeys: string[];
}

export class GroupRouteError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class GroupRouteService {
  /**
   * Build a globally optimized route.
   *
   * `start` is the driver's real location after assignment. Before assignment
   * the only honest origin we have is the host's pickup; callers pass it
   * explicitly and the quote records that this is an estimation origin.
   */
  static async plan(args: {
    start: { lat: number; lng: number };
    pickups: GroupPickupPoint[];
    destination: { lat: number; lng: number; address: string };
  }): Promise<GroupRoutePlanResult> {
    if (args.pickups.length === 0) {
      throw new GroupRouteError('NO_PICKUPS', 'Every participant must choose a pickup location first');
    }
    const destination = {
      lat: Number(args.destination.lat),
      lng: Number(args.destination.lng),
      address: args.destination.address,
    };
    if (!Number.isFinite(destination.lat) || !Number.isFinite(destination.lng)) {
      throw new GroupRouteError('NO_DESTINATION', 'Choose a destination before calculating the group route');
    }

    const nameById = new Map(args.pickups.map((p) => [p.userId, p.name]));
    const deduped = dedupePickupStops(
      args.pickups.map((p) => ({
        passengerId: p.userId,
        name: p.name,
        lat: Number(p.lat),
        lng: Number(p.lng),
        address: p.address,
        placeId: p.placeId ?? null,
      })),
    ).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

    if (deduped.length === 0) {
      throw new GroupRouteError('NO_PICKUPS', 'Every participant must choose a valid pickup location first');
    }

    const start = { lat: Number(args.start.lat), lng: Number(args.start.lng) };
    const nodes = [
      { key: '__start__', lat: start.lat, lng: start.lng },
      ...deduped.map((d) => ({ key: d.key, lat: d.lat, lng: d.lng })),
      { key: '__destination__', lat: destination.lat, lng: destination.lng },
    ];
    const coords = nodes.map((n) => [n.lat, n.lng] as [number, number]);
    const matrix = await RoutingService.routeMatrix(coords, coords);

    const cells = new Map<string, MatrixCell>();
    for (let i = 0; i < nodes.length; i++) {
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        const distance = matrix.distances[i]?.[j] ?? -1;
        const duration = matrix.durations[i]?.[j] ?? 0;
        if (distance < 0) continue;
        cells.set(matrixKey(nodes[i].key, nodes[j].key), {
          distanceMeters: distance,
          durationSeconds: duration,
        });
      }
    }

    const optimized = optimizeStopOrder({
      startId: '__start__',
      destinationId: '__destination__',
      stops: deduped.map((d) => ({ key: d.key, passengerIds: d.passengerIds })),
      matrix: cells,
    });
    if (!optimized) {
      throw new GroupRouteError(
        'ROUTE_UNAVAILABLE',
        'We could not calculate a valid route for these pickups. Check the addresses and try again.',
      );
    }

    const byKey = new Map(deduped.map((d) => [d.key, d]));
    const ordered = optimized.orderedStopKeys.map((key) => byKey.get(key)!);
    const orderedCoords = ordered.map((s) => [s.lat, s.lng] as [number, number]);

    const fullRoute = await RoutingService.calculateRouteWithWaypoints(
      [start.lat, start.lng],
      orderedCoords,
      [destination.lat, destination.lng],
    );

    const stops: PlannedStop[] = ordered.map((stop, index) => {
      const toDestination = cells.get(matrixKey(stop.key, '__destination__'));
      return {
        key: stop.key,
        sequence: index + 1,
        lat: stop.lat,
        lng: stop.lng,
        address: stop.address,
        passengerIds: [...stop.passengerIds],
        passengers: stop.passengerIds.map((id) => ({
          userId: id,
          name: nameById.get(id) ?? 'Passenger',
        })),
        distanceToDestinationMeters: toDestination?.distanceMeters ?? 0,
        durationToDestinationSeconds: toDestination?.durationSeconds ?? 0,
      };
    });

    const totalDistanceMeters = fullRoute.distanceMeters || optimized.totalDistanceMeters;
    const totalDurationSeconds = fullRoute.durationSeconds || optimized.totalDurationSeconds;

    return {
      stops,
      totalDistanceMeters,
      totalDurationSeconds,
      geometry: fullRoute.geometry,
      engine: fullRoute.engine,
      start,
      destination,
      orderedStopKeys: optimized.orderedStopKeys,
    };
  }

  /** Persist a new immutable route-plan version. Caller owns the transaction. */
  static async persist(
    client: any,
    args: {
      groupId: string;
      rideId?: string | null;
      phase: GroupRoutePhase;
      plan: GroupRoutePlanResult;
    },
  ): Promise<{ id: string; version: number }> {
    const versionRes = await client.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM ride_group_route_plans WHERE group_id = $1`,
      [args.groupId],
    );
    const version = Number(versionRes.rows[0]?.version ?? 1);
    const res = await client.query(
      `INSERT INTO ride_group_route_plans (
         group_id, ride_id, phase, version, origin_lat, origin_lng,
         destination_lat, destination_lng, destination_address,
         stops, total_distance_meters, total_duration_seconds, engine
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
       RETURNING id, version`,
      [
        args.groupId,
        args.rideId ?? null,
        args.phase,
        version,
        args.plan.start.lat,
        args.plan.start.lng,
        args.plan.destination.lat,
        args.plan.destination.lng,
        args.plan.destination.address ?? null,
        JSON.stringify({
          stops: args.plan.stops,
          geometry: args.plan.geometry,
        }),
        Math.round(args.plan.totalDistanceMeters),
        Math.round(args.plan.totalDurationSeconds),
        args.plan.engine,
      ],
    );
    return { id: res.rows[0].id, version: Number(res.rows[0].version) };
  }

  static async loadById(planId: string): Promise<any | null> {
    const res = await pool.query(`SELECT * FROM ride_group_route_plans WHERE id = $1`, [planId]);
    return res.rows[0] ?? null;
  }

  static async loadLatestForRide(rideId: string): Promise<any | null> {
    const res = await pool.query(
      `SELECT * FROM ride_group_route_plans
        WHERE ride_id = $1
        ORDER BY version DESC LIMIT 1`,
      [rideId],
    );
    return res.rows[0] ?? null;
  }

  /** Read the current driver-facing plan for a group ride. */
  static async loadDriverPlanForRide(rideId: string): Promise<any | null> {
    const res = await pool.query(
      `SELECT p.*
         FROM ride_group_route_plans p
         JOIN rides r ON r.group_id = p.group_id
        WHERE r.id = $1 AND p.phase = 'DRIVER'
        ORDER BY p.version DESC LIMIT 1`,
      [rideId],
    );
    return res.rows[0] ?? null;
  }
}
