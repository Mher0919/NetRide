// backend/src/services/fare.service.ts
import { VehicleClass } from '../types';
import { prisma } from './prisma.service';
import { redis, DRIVER_LOCATIONS_KEY } from '../config/redis';
import { LocationsService } from '../modules/location/locations.service';
import {
  getMarketConditions,
  computeDriverRange,
  resolveCurrentPrice,
  PricingInputs,
} from './pricingEngine';

const BASE_FARE = 3.50;       // Upgraded Base fare for Premium Startup
const PER_KM_RATE = 1.50;     // Upgraded Rate per KM
const MIN_FARE = 7.00;        // Minimum fare

export const fareService = {
  /**
   * Calculates the estimated fare based on distance and vehicle class.
   */
  calculateFare(distanceKm: number, vehicleClass: VehicleClass = VehicleClass.CORE): number {
    let typeMultiplier = 1.0;

    switch (vehicleClass) {
      case VehicleClass.ELITE:
        typeMultiplier = 1.6;
        break;
      case VehicleClass.PRESTIGE:
        typeMultiplier = 2.4;
        break;
      case VehicleClass.CORE:
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
  async recalculateDriverRanges(): Promise<void> {
    console.log('[PRICING] ⏳ Recalculating driver pricing ranges...');

    try {
      const market = await getMarketConditions();

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
      await redis.set('pricing:system_conditions', JSON.stringify(conditions), 'EX', 3600);

      console.log(`[PRICING] 🌍 Market shift xShift=$${market.xShift.toFixed(2)}/mi (demandRatio ${market.demandRatio.toFixed(2)}, ${market.reasons.join('; ')})`);

      const drivers = await prisma.driver.findMany();
      const { io } = await import('../app');

      for (const driver of drivers) {
        const inputs: PricingInputs = {
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

        const range = computeDriverRange(inputs, market);
        const currentPrice = resolveCurrentPrice(
          driver.price_per_mile != null ? Number(driver.price_per_mile) : null,
          range
        );

        await prisma.driver.update({
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
    } catch (err: any) {
      console.error('[PRICING] ❌ Error recalculating pricing ranges:', err.message);
    }
  },

  /**
   * Calculates rider price estimate and likelihood of saving based on nearby drivers.
   */
  async calculateRiderPriceEstimate(
    pickupLat: number,
    pickupLng: number,
    requestedClass: VehicleClass,
    distanceKm: number
  ): Promise<{ maxFare: number; savingLikelihood: number; medianPricePerMile: number }> {
    const distanceMiles = distanceKm * 0.621371;

    // Find nearby drivers (within 10km radius)
    const nearby = await LocationsService.findNearbyDrivers({ lat: pickupLat, lng: pickupLng }, 10);
    const driverIds = nearby.map(n => n.id);

    let maxPricePerMile = 3.00;
    let medianPricePerMile = 2.00;
    let savingLikelihood = 50;

    // Get current global conditions
    const conditionsStr = await redis.get('pricing:system_conditions');
    const conditions = conditionsStr ? JSON.parse(conditionsStr) : { xShift: 0.0 };
    const xShift = conditions.xShift || 0.0;

    // Default max price for classes if no drivers are found
    let classBaseBarrier = 3.00;
    if (requestedClass === VehicleClass.ELITE) classBaseBarrier = 6.00;
    else if (requestedClass === VehicleClass.PRESTIGE) classBaseBarrier = 10.00;

    if (driverIds.length > 0) {
      const drivers = await prisma.driver.findMany({
        where: {
          user_id: { in: driverIds },
          active_class: requestedClass
        }
      });

      if (drivers.length > 0) {
        const prices = drivers.map(d => {
          if (d.price_per_mile) return Number(d.price_per_mile);
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
        } else {
          medianPricePerMile = prices[mid];
        }

        // Likelihood of paying less = percentage of drivers cheaper than maxPricePerMile
        const cheaperCount = prices.filter(p => p < maxPricePerMile).length;
        savingLikelihood = prices.length > 1 
          ? Math.round((cheaperCount / prices.length) * 100) 
          : 0; // if only 1 driver, likelihood is 0% (always pay exactly that driver's price)
      } else {
        // No drivers of this specific class, default to base barrier + shift
        maxPricePerMile = classBaseBarrier + xShift;
        medianPricePerMile = Math.round((((1.00 + xShift) + maxPricePerMile) / 2) * 4) / 4;
        savingLikelihood = 50;
      }
    } else {
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

