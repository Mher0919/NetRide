import { VehicleCategory } from '../types';
export declare const fareService: {
    /**
     * Calculates the estimated fare based on distance and vehicle type.
     * Uses a fixed rate per KM and a base fare.
     */
    calculateFare(distanceKm: number, vehicleType?: VehicleCategory): number;
};
