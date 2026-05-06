"use strict";
// backend/src/services/ml-eta.service.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.MLEtaService = void 0;
class MLEtaService {
    /**
     * Advanced rule-based ETA prediction.
     * Simulates a deep model by accounting for congestion, road types, and non-linear distance friction.
     */
    static predictMultiplier(lat, lng, distanceMeters) {
        const now = new Date();
        const hour = now.getHours();
        const day = now.getDay();
        const isWeekend = (day === 0 || day === 6);
        let multiplier = 0.90; // Base: OSRM is conservative, our drivers are faster.
        // 1. Granular Congestion Model
        if (!isWeekend) {
            if (hour >= 7 && hour < 9)
                multiplier += 0.35; // AM Peak
            else if (hour >= 9 && hour < 11)
                multiplier += 0.15; // AM Shoulder
            else if (hour >= 16 && hour < 18)
                multiplier += 0.45; // PM Peak (Worst)
            else if (hour >= 18 && hour < 20)
                multiplier += 0.25; // PM Shoulder
        }
        else {
            if (hour >= 11 && hour < 20)
                multiplier += 0.15; // Weekend mid-day traffic
        }
        // 2. Late Night Speed-up (Free flow)
        if (hour >= 23 || hour < 5) {
            multiplier -= 0.20;
        }
        // 3. Dense Urban Factor (Simulated "Deep" Feature)
        // LA Downtown / Santa Monica core detection
        const isDenseUrban = (lat > 34.02 && lat < 34.06 && lng > -118.27 && lng < -118.23) || // DTLA
            (lat > 34.00 && lat < 34.03 && lng > -118.50 && lng < -118.47); // Santa Monica
        if (isDenseUrban) {
            multiplier += 0.20; // Signal lights and pedestrian density
        }
        // 4. Non-Linear Distance Friction
        // Very short trips (<1km) have high overhead (parking, U-turns)
        if (distanceMeters < 1000) {
            multiplier += 0.25;
        }
        // Long highway trips (>10km) usually maintain higher average speeds
        else if (distanceMeters > 10000) {
            multiplier -= 0.10;
        }
        // Hard floor and ceiling for safety
        return Math.min(2.5, Math.max(0.55, multiplier));
    }
}
exports.MLEtaService = MLEtaService;
//# sourceMappingURL=ml-eta.service.js.map