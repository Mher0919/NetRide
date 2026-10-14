import { Trip, Location } from '../../types';
import { TerminalCancelGuard } from './ride-state.rules';
export { TerminalCancelGuard, buildTerminalCancelGuardSql } from './ride-state.rules';
export declare class RideService {
    static rateRide(data: {
        ride_id: string;
        rater_id: string;
        rating: number;
        review_text?: string;
    }): Promise<any>;
    static requestRide(riderId: string, pickup: Location & {
        address: string;
    }, destination: Location & {
        address: string;
    }, scheduledAt?: Date, isScheduled?: boolean, idempotencyKey?: string, rewards?: {
        promoCode?: string;
        applyCredits?: boolean;
        creditUseCents?: number;
        specialRedemptionId?: string;
        specialTermsAccepted?: boolean;
    }, favoritePriority?: boolean): Promise<Trip>;
    static acceptTrip(tripId: string, driverId: string): Promise<Trip>;
    /**
     * Atomic ACCEPTED → DRIVER_ARRIVING transition, triggered when a fresh,
     * non-mock driver fix enters the pickup radius. Idempotent: a repeated
     * call after the flip returns `changed: false` without touching the row,
     * so concurrent location updates can never double-broadcast or regress a
     * ride that already started.
     */
    static markDriverArriving(tripId: string, driverId: string): Promise<{
        changed: boolean;
        trip: Trip;
    }>;
    /**
     * Decline a ride offer. Idempotent and safe to retry from either the
     * socket or the REST notification-action path: the offer transition only
     * fires from SENT, the driver-specific exclusion upsert is keyed by
     * (ride, driver), and matching is only re-enqueued while the ride is
     * still REQUESTED.
     */
    static declineTrip(tripId: string, driverId: string, offerId?: string): Promise<{
        declined: boolean;
    }>;
    static updateTripStatus(tripId: string, status: any, userId: string, opts?: {
        bypassDriverGuard?: boolean;
    }): Promise<Trip>;
    static cancelTrip(tripId: string, userId: string, opts?: {
        reasonCode?: string;
        reasonText?: string;
        bypassOwnership?: boolean;
    }): Promise<Trip>;
    /**
     * System-driven terminal cancellation (stale-ride watchdog / boots-time
     * reconciliation). No human actor: `cancelled_by` stays NULL, no reason
     * code is required, and there is NO pre-pickup rematch — the ride is
     * dissolved permanently so neither party's app can keep routing to it.
     * Idempotent — safe to call repeatedly from every cleanup tick.
     */
    static cancelTripSystem(tripId: string, opts?: {
        reasonText?: string;
        guard?: TerminalCancelGuard;
    }): Promise<Trip | null>;
    /**
     * Shared terminal-cancellation core used by party cancels (cancelTrip),
     * system cancels (cancelTripSystem) and admin cancels. Atomic status
     * guard + rewards/sponsor teardown + safety/navigation teardown +
     * authoritative broadcast to both parties and admin monitoring.
     */
    private static _terminalCancel;
    static getHistory(userId: string, role: string): Promise<Trip[]>;
    static getCurrentRide(userId: string, role: string): Promise<Trip | null>;
    static deleteHistory(rideId: string, userId: string): Promise<boolean>;
}
