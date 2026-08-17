import { Trip, TripStatus } from '../../types';
/**
 * DRIVER PRE-PICKUP RELEASE (Scenario B, ACCEPTED → SEARCHING).
 *
 * Exported SQL contract (asserted in ride-cancellation.unit.test.ts): the
 * atomic guard `AND driver_id = $2 AND status IN (...)` is what makes the
 * release safe against stale/delayed driver actions — a cancel from a
 * driver who is no longer assigned, or for a ride that already flipped,
 * matches zero rows and cannot clobber a fresher assignment (spec §16/§17).
 */
export declare const RELEASE_DRIVER_PRE_PICKUP_SQL = "UPDATE rides\n      SET status = $3,\n          driver_id = NULL,\n          cancelled_at = NULL,\n          cancelled_by = NULL,\n          cancellation_reason_code = NULL,\n          cancellation_reason_text = NULL\n    WHERE id = $1 AND driver_id = $2 AND status IN ($4, $5)\n    RETURNING id";
/**
 * Driver-specific interaction history upsert (shared by the REJECTED and
 * ACCEPTED_THEN_CANCELLED paths). Kept beside the ride SQL so the release
 * transaction stays one file.
 */
export declare const UPSERT_DRIVER_RIDE_INTERACTION_SQL = "INSERT INTO ride_driver_rejections\n     (ride_id, driver_id, status, interaction_type, reason_code, reason_text, rejected_at)\n     VALUES ($1, $2, $3, $4, $5, $6, NOW())\n     ON CONFLICT (ride_id, driver_id)\n     DO UPDATE SET\n       status = EXCLUDED.status,\n       interaction_type = EXCLUDED.interaction_type,\n       reason_code = COALESCE(EXCLUDED.reason_code, ride_driver_rejections.reason_code),\n       reason_text = COALESCE(EXCLUDED.reason_text, ride_driver_rejections.reason_text),\n       rejected_at = NOW()";
export declare class RideRepository {
    static create(data: {
        rider_id: string;
        pickup_lat: number;
        pickup_lng: number;
        pickup_address: string;
        destination_lat: number;
        destination_lng: number;
        destination_address: string;
        requested_class?: string;
        snapshot_rider_rating?: number;
    }): Promise<Trip>;
    private static readonly DRIVER_VEHICLE_JOIN;
    static findById(id: string): Promise<Trip | null>;
    static updateStatus(id: string, status: TripStatus, extra?: any): Promise<Trip>;
    static findByRiderId(riderId: string): Promise<Trip[]>;
    static findByDriverId(driverId: string): Promise<Trip[]>;
    static findCurrentByRiderId(riderId: string): Promise<Trip | null>;
    static findCurrentByDriverId(driverId: string): Promise<Trip | null>;
    static delete(id: string, userId: string): Promise<boolean>;
    private static mapToTrip;
}
