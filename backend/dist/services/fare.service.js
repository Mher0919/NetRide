"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.fareService = void 0;
// backend/src/services/fare.service.ts
const types_1 = require("../types");
const prisma_service_1 = require("./prisma.service");
const redis_1 = require("../config/redis");
const locations_service_1 = require("../modules/location/locations.service");
const pricingEngine_1 = require("./pricingEngine");
const BASE_FARE = 3.50; // Upgraded Base fare for Premium Startup
const PER_KM_RATE = 1.50; // Upgraded Rate per KM
const MIN_FARE = 7.00; // Minimum fare
// Pure, in-memory fare constants — no I/O, computed in microseconds.
const BOOKING_FEE = 1.50;
const PER_MINUTE_RATE = 0.35;
const SERVICE_FEE_RATE = 0.10; // 10% of (base + distance + time)
const TAX_RATE = 0.0875; // 8.75% (CA statewide + local)
const CLASS_DISTANCE_MULTIPLIER = {
    [types_1.VehicleClass.CORE]: 1.0,
    [types_1.VehicleClass.ELITE]: 1.6,
    [types_1.VehicleClass.PRESTIGE]: 2.4,
};
/** Round to 2 decimal places. */
function round2(n) {
    return Math.round(n * 100) / 100;
}
exports.fareService = {
    /**
     * Fast, deterministic, in-memory fare computation for the routing hot
     * path. No database, no network — only arithmetic. Takes microseconds.
     *
     * Returns a full itemized breakdown so the rider UI can render an
     * Uber-style fare card instantly.
     */
    computeFare(input) {
        const distanceKm = input.distanceMeters / 1000;
        const durationMinutes = input.durationSeconds / 60;
        const classMultiplier = CLASS_DISTANCE_MULTIPLIER[input.vehicleClass] ?? 1.0;
        const baseFare = BASE_FARE * classMultiplier;
        const distanceFare = distanceKm * PER_KM_RATE * classMultiplier;
        const timeFare = durationMinutes * PER_MINUTE_RATE * classMultiplier;
        // Surge is 1.0 on the planning path; recomputed from live market at
        // request time by calculateRiderPriceEstimate when dynamic pricing applies.
        const surgeMultiplier = 1.0;
        const bookingFee = BOOKING_FEE;
        const subtotal = baseFare + distanceFare + timeFare + bookingFee;
        const serviceFee = subtotal * SERVICE_FEE_RATE;
        const taxable = subtotal + serviceFee;
        const taxes = taxable * TAX_RATE;
        const totalFareRaw = taxable + taxes;
        const totalFare = Math.max(MIN_FARE * classMultiplier, round2(totalFareRaw));
        return {
            baseFare: round2(baseFare),
            distanceFare: round2(distanceFare),
            timeFare: round2(timeFare),
            bookingFee: round2(bookingFee),
            surgeMultiplier,
            serviceFee: round2(serviceFee),
            taxes: round2(taxes),
            totalFare,
            currency: 'USD',
        };
    },
    /**
     * Calculates the estimated fare based on distance and vehicle class.
     * Retained for non-hot-path callers (admin, tests).
     */
    calculateFare(distanceKm, vehicleClass = types_1.VehicleClass.CORE) {
        let typeMultiplier = 1.0;
        switch (vehicleClass) {
            case types_1.VehicleClass.ELITE:
                typeMultiplier = 1.6;
                break;
            case types_1.VehicleClass.PRESTIGE:
                typeMultiplier = 2.4;
                break;
            case types_1.VehicleClass.CORE:
            default:
                typeMultiplier = 1.0;
        }
        const calculatedFare = (BASE_FARE + distanceKm * PER_KM_RATE) * typeMultiplier;
        const finalFare = Math.max(MIN_FARE, calculatedFare);
        return Math.round(finalFare * 100) / 100; // Round to 2 decimal places
    },
    /**
     * Recalculates price ranges and barriers for all drivers.
     * Delegates ALL range math to the centralized, deterministic pricing engine.
     * Considers rating, completed rides, flags, dangerous status, reliability,
     * and live (non-random) market conditions.
     */
    async recalculateDriverRanges() {
        console.log('[PRICING] ⏳ Recalculating driver pricing ranges...');
        try {
            const market = await (0, pricingEngine_1.getMarketConditions)();
            // Store current conditions in Redis for visibility / rider estimates.
            const conditions = {
                xShift: market.xShift,
                demandRatio: market.demandRatio,
                activeRequests: market.activeRequests,
                onlineDrivers: market.onlineDrivers,
                hourOfDay: market.hourOfDay,
                reasons: market.reasons,
                timestamp: Date.now(),
            };
            await redis_1.redis.set('pricing:system_conditions', JSON.stringify(conditions), 'EX', 3600);
            console.log(`[PRICING] 🌍 Market shift xShift=$${market.xShift.toFixed(2)}/mi (demandRatio ${market.demandRatio.toFixed(2)}, ${market.reasons.join('; ')})`);
            const drivers = await prisma_service_1.prisma.driver.findMany();
            const { io } = await Promise.resolve().then(() => __importStar(require('../app')));
            for (const driver of drivers) {
                const inputs = {
                    user_id: driver.user_id,
                    active_class: driver.active_class,
                    rating: Number(driver.rating ?? 5.0),
                    total_rides: driver.total_rides ?? 0,
                    acceptance_count: driver.acceptance_count ?? 0,
                    cancellation_count: driver.cancellation_count ?? 0,
                    is_dangerous: !!driver.is_dangerous,
                    is_flagged: !!driver.is_flagged,
                    last_cancellation_at: driver.last_cancellation_at ?? null,
                };
                const range = (0, pricingEngine_1.computeDriverRange)(inputs, market);
                const currentPrice = (0, pricingEngine_1.resolveCurrentPrice)(driver.price_per_mile != null ? Number(driver.price_per_mile) : null, range);
                await prisma_service_1.prisma.driver.update({
                    where: { user_id: driver.user_id },
                    data: {
                        price_range_min: range.price_range_min,
                        price_range_max: range.price_range_max,
                        recommended_price: range.recommended_price,
                        price_per_mile: currentPrice,
                    },
                });
                io.to(`driver:${driver.user_id}`).emit('pricingUpdate', {
                    price_per_mile: currentPrice,
                    price_range_min: range.price_range_min,
                    price_range_max: range.price_range_max,
                    recommended_price: range.recommended_price,
                    price_last_changed: driver.price_last_changed,
                });
            }
            console.log(`[PRICING] ✅ Recalculated pricing ranges for ${drivers.length} drivers.`);
        }
        catch (err) {
            console.error('[PRICING] ❌ Error recalculating pricing ranges:', err.message);
        }
    },
    /**
     * Calculates rider price estimate and likelihood of saving based on nearby drivers.
     */
    async calculateRiderPriceEstimate(pickupLat, pickupLng, requestedClass, distanceKm) {
        const distanceMiles = distanceKm * 0.621371;
        // Find nearby drivers (within 10km radius)
        const nearby = await locations_service_1.LocationsService.findNearbyDrivers({ lat: pickupLat, lng: pickupLng }, 10);
        const driverIds = nearby.map(n => n.id);
        let maxPricePerMile = 3.00;
        let medianPricePerMile = 2.00;
        let savingLikelihood = 50;
        // Get current global conditions
        const conditionsStr = await redis_1.redis.get('pricing:system_conditions');
        const conditions = conditionsStr ? JSON.parse(conditionsStr) : { xShift: 0.0 };
        const xShift = conditions.xShift || 0.0;
        // Default $/mile per package (used only when there is zero pricing data).
        let classBaseBarrier = 3.00;
        if (requestedClass === types_1.VehicleClass.ELITE)
            classBaseBarrier = 6.00;
        else if (requestedClass === types_1.VehicleClass.PRESTIGE)
            classBaseBarrier = 10.00;
        // Pull a price-per-mile for a driver row, falling back to the midpoint of
        // their stored range, then to the package default.
        const priceFor = (d) => {
            if (d.price_per_mile)
                return Number(d.price_per_mile);
            const min = Number(d.price_range_min || (1.00 + xShift));
            const max = Number(d.price_range_max || (classBaseBarrier + xShift));
            return Math.round(((min + max) / 2) * 4) / 4;
        };
        const summarize = (prices) => {
            prices.sort((a, b) => a - b);
            maxPricePerMile = prices[prices.length - 1];
            const mid = Math.floor(prices.length / 2);
            medianPricePerMile = prices.length % 2 === 0
                ? (prices[mid - 1] + prices[mid]) / 2
                : prices[mid];
            const cheaperCount = prices.filter(p => p < maxPricePerMile).length;
            savingLikelihood = prices.length > 1
                ? Math.round((cheaperCount / prices.length) * 100)
                : 0;
        };
        if (driverIds.length > 0) {
            // Tier 1: online drivers of this class near the pickup.
            const onlineDrivers = await prisma_service_1.prisma.driver.findMany({
                where: { user_id: { in: driverIds }, active_class: requestedClass }
            });
            if (onlineDrivers.length > 0) {
                summarize(onlineDrivers.map(priceFor));
                return _finalizeEstimate(maxPricePerMile, medianPricePerMile, savingLikelihood, distanceMiles);
            }
        }
        // Tier 2: no drivers online nearby — use the latest drivers of this class
        // that have been online (the whole fleet for that package) so the rider
        // still sees a real, data-driven price instead of $0.
        const fleetDrivers = await prisma_service_1.prisma.driver.findMany({
            where: { active_class: requestedClass },
            take: 200,
        });
        if (fleetDrivers.length > 0) {
            summarize(fleetDrivers.map(priceFor));
            return _finalizeEstimate(maxPricePerMile, medianPricePerMile, savingLikelihood, distanceMiles);
        }
        // Tier 3: absolutely no pricing data anywhere — use the package default
        // $/mile so the estimate is always a sensible, non-zero number.
        maxPricePerMile = classBaseBarrier + xShift;
        medianPricePerMile = Math.round((((1.00 + xShift) + maxPricePerMile) / 2) * 4) / 4;
        savingLikelihood = 50;
        return _finalizeEstimate(maxPricePerMile, medianPricePerMile, savingLikelihood, distanceMiles);
    }
};
// Build the estimate response, guaranteeing a non-zero max fare.
function _finalizeEstimate(maxPricePerMile, medianPricePerMile, savingLikelihood, distanceMiles) {
    const calculatedMaxFare = maxPricePerMile * distanceMiles;
    const finalMaxFare = Math.round(Math.max(5.00, calculatedMaxFare) * 100) / 100;
    return {
        maxFare: finalMaxFare,
        savingLikelihood,
        medianPricePerMile: Math.round(medianPricePerMile * 100) / 100,
    };
}
//# sourceMappingURL=fare.service.js.map