import { EventEmitter } from 'events';
import { Location } from '../../types';
/**
 * A raw location observation as reported by a device. Only lat/lng are
 * mandatory; everything else may be absent on older clients.
 */
export interface LocationFix extends Location {
    /** Horizontal accuracy in meters as reported by the OS (null = unknown). */
    accuracy?: number | null;
    /** Device heading in degrees (null = unknown). */
    heading?: number | null;
    /** Device-reported speed in m/s (null = unknown). */
    speed?: number | null;
    /** True when the OS marks the fix as coming from a mock/spoofed provider. */
    mock?: boolean;
    /** Device-supplied ISO timestamp (never trusted for freshness decisions). */
    deviceAt?: string | null;
    /** Observation source label for diagnostics. */
    source?: string | null;
}
/**
 * The stored, timestamped observation. `serverAt` is the server's own
 * receive time; freshness and every safety-relevant gate must use it, never
 * a device clock.
 */
export interface DriverLocationRecord extends Location {
    serverAt: number;
    accuracy: number | null;
    heading: number | null;
    speed: number | null;
    mock: boolean;
    deviceAt: string | null;
    source: string;
}
export interface LocationFreshness {
    fresh: boolean;
    ageSeconds: number | null;
}
/**
 * Pure freshness evaluation (unit-tested): a location is fresh when the
 * server observed it no longer than `maxAgeS` ago. A missing/absent
 * timestamp is never fresh. Clock skew is one-sided: future timestamps
 * (negative age) are treated as age 0 rather than rejected.
 */
export declare function evaluateLocationFreshness(serverAt: number | null | undefined, nowMs: number, maxAgeS: number): LocationFreshness;
/**
 * In-process emitter for buffered trajectory points.
 *
 *   const { trajectoryEvents } = require('./locations.service');
 *   trajectoryEvents.on('point', ({ driverId, tripId, point }) => …);
 *
 * The payload matches what `SpeedingDetector.onTrajectoryPoint` expects
 * (lat/lng/speed_mps/t). Speed is optional — mobile clients may not
 * always report it; consumers must handle null/missing values.
 */
export interface TrajectoryPointPayload {
    driverId: string;
    tripId: string;
    point: {
        lat: number;
        lng: number;
        /** meters/second — null when the device didn't report it */
        speed_mps: number | null;
        /** ISO timestamp */
        t: string;
    };
}
export declare const trajectoryEvents: EventEmitter<[never]>;
export declare class LocationsService {
    /**
     * Updates a driver's real-time location in Redis
     * Also sets a heartbeat to track online status and returns the geohash for room management.
     */
    static updateDriverLocation(driverId: string, loc: LocationFix): Promise<string>;
    /**
     * Internal helper to buffer trajectory points in Redis.
     *
     * Side effect: emits `point` on `trajectoryEvents` after the
     * throttle/buffer work so the speeding detector (and any future
     * safety module) can subscribe without re-reading the buffer.
     */
    private static bufferTrajectory;
    static getTrajectory(tripId: string): Promise<any[]>;
    static clearTrajectory(tripId: string): Promise<void>;
    /**
     * Finds nearby online drivers within a radius using the H3 hexagonal index.
     *
     * Instead of scanning the global GEO set (O(all online drivers) in the worst
     * case), it computes the rider's H3 cell, expands to a small disk of cells
     * that fully covers the radius, and unions only those cell sets — the query
     * cost scales with the number of cells in the ring, not the total fleet.
     * Filters out drivers whose heartbeats have expired using pipelined MGET.
     */
    static findNearbyDrivers(loc: Location, radiusKm: number): Promise<{
        id: string;
        distance: number;
    }[]>;
    /**
     * Classic GEORADIUS scan, kept as a fallback when the H3 index has no data.
     */
    private static _georadiusFallback;
    /**
     * Removes a driver from online tracking (GEO set, heartbeat, location
     * record, availability lease, H3 cell index).
     */
    static removeDriverLocation(driverId: string): Promise<void>;
    static markDriverOnline(driverId: string): Promise<number>;
    static clearDriverOnline(driverId: string): Promise<void>;
    static isDriverOnline(driverId: string): Promise<boolean>;
    /**
     * Renews the raw heartbeat without changing the position. Used by
     * `goOnline` when the client has no fresh fix yet but a stored record
     * exists (e.g. reconnect) so the driver is not silently dropped from
     * dispatch while waiting for the first GPS sample.
     */
    static touchHeartbeat(driverId: string): Promise<void>;
    /** Raw stored observation record (no freshness judgement). */
    static getDriverLocationRecord(driverId: string): Promise<DriverLocationRecord | null>;
    /**
     * Returns the driver's last-known position with its freshness metadata.
     * `stale`/`mock` are explicit so callers can refuse to treat an obsolete
     * or spoofed coordinate as live (safety gates, ETAs, notifications).
     * Falls back to the GEO set when the record is missing (legacy entries)
     * with `serverAt: null` → always stale.
     */
    static getDriverLocation(driverId: string): Promise<(DriverLocationRecord & {
        stale: boolean;
        ageSeconds: number | null;
    }) | null>;
    /** Freshness assessment for the stored record (dispatch eligibility). */
    static isLocationFresh(driverId: string): Promise<boolean>;
}
