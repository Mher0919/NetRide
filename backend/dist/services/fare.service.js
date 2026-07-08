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
const BASE_FARE = 3.50; // Upgraded Base fare for Premium Startup
const PER_KM_RATE = 1.50; // Upgraded Rate per KM
const MIN_FARE = 7.00; // Minimum fare
exports.fareService = {
    /**
     * Calculates the estimated fare based on distance and vehicle class.
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
     * Recalculates price ranges and barriers for all drivers every 30 minutes.
     * Considers rating, completed rides, flags, dangerous status, and dynamic global conditions.
     */
    async recalculateDriverRanges() {
        console.log('[PRICING] ⏳ Recalculating driver pricing ranges...');
        try {
            // 1. Simulate/determine global system shift conditions
            // Weather: sunny (70%), rainy (20%), stormy (10%)
            const weatherRand = Math.random();
            const weather = weatherRand < 0.7 ? 'sunny' : weatherRand < 0.9 ? 'rainy' : 'stormy';
            // Traffic: low (40%), medium (40%), high (20%)
            const trafficRand = Math.random();
            const traffic = trafficRand < 0.4 ? 'low' : trafficRand < 0.8 ? 'medium' : 'high';
            // Active requests in last 30 minutes
            const activeRequestsRes = await prisma_service_1.prisma.$queryRawUnsafe("SELECT COUNT(*)::int as count FROM rides WHERE created_at > NOW() - INTERVAL '30 minutes'");
            const activeRequests = activeRequestsRes[0]?.count || 0;
            // Online drivers in Redis
            const onlineDrivers = await redis_1.redis.zcard(redis_1.DRIVER_LOCATIONS_KEY);
            // Demand/Supply Ratio
            const demandRatio = activeRequests / Math.max(1, onlineDrivers);
            // Shift amounts
            let weatherShift = 0.00;
            if (weather === 'rainy')
                weatherShift = 0.50;
            else if (weather === 'stormy')
                weatherShift = 1.00;
            let trafficShift = 0.00;
            if (traffic === 'medium')
                trafficShift = 0.25;
            else if (traffic === 'high')
                trafficShift = 0.75;
            let demandShift = 0.00;
            if (demandRatio >= 1.5)
                demandShift = 0.50;
            else if (demandRatio <= 0.5)
                demandShift = -0.25;
            const xShift = weatherShift + trafficShift + demandShift;
            // Store current conditions in Redis for visibility
            const conditions = {
                weather,
                traffic,
                activeRequests,
                onlineDrivers,
                xShift,
                timestamp: Date.now()
            };
            await redis_1.redis.set('pricing:system_conditions', JSON.stringify(conditions), 'EX', 3600);
            console.log(`[PRICING] 🌍 Global shift conditions updated: Shift=\$${xShift.toFixed(2)}/mile. Weather: ${weather}, Traffic: ${traffic}, Demand ratio: ${demandRatio.toFixed(2)}`);
            // 2. Fetch all drivers
            const drivers = await prisma_service_1.prisma.driver.findMany({
                include: {
                    user: true
                }
            });
            const { io } = await Promise.resolve().then(() => __importStar(require('../app')));
            for (const driver of drivers) {
                // Base barrier for vehicle class
                let baseBarrier = 3.00; // CORE / Regular
                if (driver.active_class === types_1.VehicleClass.ELITE)
                    baseBarrier = 6.00;
                else if (driver.active_class === types_1.VehicleClass.PRESTIGE)
                    baseBarrier = 10.00;
                let barrierMultiplier = 1.0;
                // Rating adjustment
                const rating = Number(driver.rating || 5.00);
                if (rating < 4.8 && rating >= 4.5) {
                    barrierMultiplier *= 0.90; // 10% reduction
                }
                else if (rating < 4.5 && rating >= 4.0) {
                    barrierMultiplier *= 0.75; // 25% reduction
                }
                else if (rating < 4.0) {
                    barrierMultiplier *= 0.50; // 50% reduction
                }
                // Flagged/Dangerous driver adjustments
                if (driver.is_dangerous) {
                    barrierMultiplier *= 0.50; // 50% reduction for dangerous driving
                }
                if (driver.is_flagged) {
                    barrierMultiplier *= 0.70; // 30% reduction for general flags
                }
                // Completed rides experience adjustment
                const totalRides = driver.total_rides || 0;
                if (totalRides < 10) {
                    barrierMultiplier *= 0.90; // 10% reduction for inexperienced drivers
                }
                // Calculate final adjusted max barrier before shift
                const baseBarrierAdjusted = baseBarrier * barrierMultiplier;
                // Apply shift
                let min = 1.00 + xShift;
                let max = baseBarrierAdjusted + xShift;
                // Round ranges to nearest 25 cents
                min = Math.round(min * 4) / 4;
                max = Math.round(max * 4) / 4;
                // Enforce bounds
                if (min < 1.00)
                    min = 1.00;
                // Enforce difference of AT LEAST 2.00
                if (max - min < 2.00) {
                    max = min + 2.00;
                }
                // Calculate recommended price depending on the demand factor
                const demandFactor = Math.min(1.0, Math.max(0.0, demandRatio / 2.0));
                let recommendedPrice = min + (max - min) * demandFactor;
                recommendedPrice = Math.round(recommendedPrice * 4) / 4;
                if (recommendedPrice < min)
                    recommendedPrice = min;
                if (recommendedPrice > max)
                    recommendedPrice = max;
                // Driver custom price per mile logic
                let currentPrice = driver.price_per_mile ? Number(driver.price_per_mile) : null;
                if (currentPrice === null) {
                    // First time driving: assign middle of the range
                    currentPrice = Math.round(((min + max) / 2) * 4) / 4;
                }
                else {
                    // Clamp to new range
                    currentPrice = Math.max(min, Math.min(max, currentPrice));
                }
                // Save back to DB
                await prisma_service_1.prisma.driver.update({
                    where: { user_id: driver.user_id },
                    data: {
                        price_range_min: min,
                        price_range_max: max,
                        recommended_price: recommendedPrice,
                        price_per_mile: currentPrice
                    }
                });
                // Notify driver socket if connected
                io.to(`driver:${driver.user_id}`).emit('pricingUpdate', {
                    price_per_mile: currentPrice,
                    price_range_min: min,
                    price_range_max: max,
                    recommended_price: recommendedPrice,
                    price_last_changed: driver.price_last_changed
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
        // Default max price for classes if no drivers are found
        let classBaseBarrier = 3.00;
        if (requestedClass === types_1.VehicleClass.ELITE)
            classBaseBarrier = 6.00;
        else if (requestedClass === types_1.VehicleClass.PRESTIGE)
            classBaseBarrier = 10.00;
        if (driverIds.length > 0) {
            const drivers = await prisma_service_1.prisma.driver.findMany({
                where: {
                    user_id: { in: driverIds },
                    active_class: requestedClass
                }
            });
            if (drivers.length > 0) {
                const prices = drivers.map(d => {
                    if (d.price_per_mile)
                        return Number(d.price_per_mile);
                    const min = Number(d.price_range_min || (1.00 + xShift));
                    const max = Number(d.price_range_max || (classBaseBarrier + xShift));
                    return Math.round(((min + max) / 2) * 4) / 4;
                });
                prices.sort((a, b) => a - b);
                maxPricePerMile = prices[prices.length - 1];
                // Find median
                const mid = Math.floor(prices.length / 2);
                if (prices.length % 2 === 0) {
                    medianPricePerMile = (prices[mid - 1] + prices[mid]) / 2;
                }
                else {
                    medianPricePerMile = prices[mid];
                }
                // Likelihood of paying less = percentage of drivers cheaper than maxPricePerMile
                const cheaperCount = prices.filter(p => p < maxPricePerMile).length;
                savingLikelihood = prices.length > 1
                    ? Math.round((cheaperCount / prices.length) * 100)
                    : 0; // if only 1 driver, likelihood is 0% (always pay exactly that driver's price)
            }
            else {
                // No drivers of this specific class, default to base barrier + shift
                maxPricePerMile = classBaseBarrier + xShift;
                medianPricePerMile = Math.round((((1.00 + xShift) + maxPricePerMile) / 2) * 4) / 4;
                savingLikelihood = 50;
            }
        }
        else {
            // No nearby drivers at all
            maxPricePerMile = classBaseBarrier + xShift;
            medianPricePerMile = Math.round((((1.00 + xShift) + maxPricePerMile) / 2) * 4) / 4;
            savingLikelihood = 50;
        }
        const calculatedMaxFare = maxPricePerMile * distanceMiles;
        // Base minimum fare is 5.00
        const finalMaxFare = Math.round(Math.max(5.00, calculatedMaxFare) * 100) / 100;
        return {
            maxFare: finalMaxFare,
            savingLikelihood,
            medianPricePerMile: Math.round(medianPricePerMile * 100) / 100
        };
    }
};
//# sourceMappingURL=fare.service.js.map