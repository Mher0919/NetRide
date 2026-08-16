import { Trip, Location } from '../../types';
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
    }, favoritePriority?: boolean): Promise<Trip>;
    static acceptTrip(tripId: string, driverId: string): Promise<Trip>;
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
