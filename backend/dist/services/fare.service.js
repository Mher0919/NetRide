"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fareService = void 0;
// backend/src/services/fare.service.ts
const types_1 = require("../types");
const BASE_FARE = 2.50; // Base fare in USD
const PER_KM_RATE = 1.20; // Rate per KM in USD
const MIN_FARE = 5.00; // Minimum fare in USD
exports.fareService = {
    /**
     * Calculates the estimated fare based on distance and vehicle type.
     * Uses a fixed rate per KM and a base fare.
     */
    calculateFare(distanceKm, vehicleType = types_1.VehicleCategory.ECONOMY) {
        let typeMultiplier = 1.0;
        switch (vehicleType) {
            case types_1.VehicleCategory.EXTRA:
                typeMultiplier = 1.3;
                break;
            case types_1.VehicleCategory.LUX:
                typeMultiplier = 1.8;
                break;
            case types_1.VehicleCategory.SUV_LUX:
                typeMultiplier = 2.0;
                break;
            case types_1.VehicleCategory.PREMIER:
                typeMultiplier = 2.5;
                break;
            case types_1.VehicleCategory.ECONOMY:
            default:
                typeMultiplier = 1.0;
        }
        const calculatedFare = (BASE_FARE + distanceKm * PER_KM_RATE) * typeMultiplier;
        const finalFare = Math.max(MIN_FARE, calculatedFare);
        return Math.round(finalFare * 100) / 100; // Round to 2 decimal places
    }
};
//# sourceMappingURL=fare.service.js.map