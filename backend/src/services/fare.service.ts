// backend/src/services/fare.service.ts
import { VehicleCategory } from '../types';

const BASE_FARE = 2.50;       // Base fare in USD
const PER_KM_RATE = 1.20;     // Rate per KM in USD
const MIN_FARE = 5.00;        // Minimum fare in USD

export const fareService = {
  /**
   * Calculates the estimated fare based on distance and vehicle type.
   * Uses a fixed rate per KM and a base fare.
   */
  calculateFare(distanceKm: number, vehicleType: VehicleCategory = VehicleCategory.ECONOMY): number {
    let typeMultiplier = 1.0;

    switch (vehicleType) {
      case VehicleCategory.SUV:
        typeMultiplier = 1.5;
        break;
      case VehicleCategory.VAN:
        typeMultiplier = 1.8;
        break;
      case VehicleCategory.PREMIUM:
        typeMultiplier = 2.0;
        break;
      case VehicleCategory.ECONOMY:
      default:
        typeMultiplier = 1.0;
    }

    const calculatedFare = (BASE_FARE + distanceKm * PER_KM_RATE) * typeMultiplier;
    const finalFare = Math.max(MIN_FARE, calculatedFare);

    return Math.round(finalFare * 100) / 100; // Round to 2 decimal places
  }
};
