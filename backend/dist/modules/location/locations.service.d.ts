import { EventEmitter } from 'events';
import { Location } from '../../types';
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
    static updateDriverLocation(driverId: string, loc: Location): Promise<string>;
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
     * Removes a driver from online tracking (GEO set, heartbeat, H3 cell index)
     */
    static removeDriverLocation(driverId: string): Promise<void>;
    static getDriverLocation(driverId: string): Promise<Location | null>;
}
