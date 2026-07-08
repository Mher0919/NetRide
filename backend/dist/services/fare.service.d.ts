import { VehicleClass } from '../types';
export declare const fareService: {
    /**
     * Calculates the estimated fare based on distance and vehicle class.
     */
    calculateFare(distanceKm: number, vehicleClass?: VehicleClass): number;
    /**
     * Recalculates price ranges and barriers for all drivers every 30 minutes.
     * Considers rating, completed rides, flags, dangerous status, and dynamic global conditions.
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
