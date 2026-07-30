import { VehicleClass } from '../types';
export interface FareInput {
    /** Trip distance in meters. */
    distanceMeters: number;
    /** Expected trip duration in seconds (for the time component). */
    durationSeconds: number;
    vehicleClass: VehicleClass;
    /**
     * Price per mile from the dynamic pricing engine.
     * When set, replaces the static PER_KM_RATE for the distance component,
     * using the highest default latest price in the class range.
     */
    pricePerMile?: number;
}
export interface FareBreakdown {
    baseFare: number;
    distanceFare: number;
    timeFare: number;
    bookingFee: number;
    surgeMultiplier: number;
    serviceFee: number;
    taxes: number;
    totalFare: number;
    currency: 'USD';
}
export type { FareBreakdown as FareBreakdownType };
export declare const fareService: {
    /**
     * Fast, deterministic, in-memory fare computation for the routing hot
     * path. No database, no network — only arithmetic. Takes microseconds.
     *
     * Returns a full itemized breakdown so the rider UI can render an
     * Uber-style fare card instantly.
     */
    computeFare(input: FareInput): FareBreakdown;
    /**
     * Calculates the estimated fare based on distance and vehicle class.
     * Retained for non-hot-path callers (admin, tests).
     */
    calculateFare(distanceKm: number, vehicleClass?: VehicleClass): number;
    /**
     * Recalculates price ranges and barriers for all drivers.
     * Delegates ALL range math to the centralized, deterministic pricing engine.
     * Considers rating, completed rides, flags, dangerous status, reliability,
     * and live (non-random) market conditions.
     */
    recalculateDriverRanges(): Promise<void>;
    /**
     * Calculates rider price estimate and likelihood of saving based on nearby drivers.
     */
    calculateRiderPriceEstimate(pickupLat: number, pickupLng: number, requestedClass: VehicleClass, distanceKm: number): Promise<{
        maxFare: number;
        savingLikelihood: number;
        medianPricePerMile: number;
    }>;
};
