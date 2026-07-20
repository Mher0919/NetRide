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

export interface FareInput {
  /** Trip distance in meters. */
  distanceMeters: number;
  /** Expected trip duration in seconds (for the time component). */
  durationSeconds: number;
  vehicleClass: VehicleClass;
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

// Pure, in-memory fare constants — no I/O, computed in microseconds.
const BOOKING_FEE = 1.50;
const PER_MINUTE_RATE = 0.35;
const SERVICE_FEE_RATE = 0.10;   // 10% of (base + distance + time)
const TAX_RATE = 0.0875;         // 8.75% (CA statewide + local)

const CLASS_DISTANCE_MULTIPLIER: Record<VehicleClass, number> = {
  [VehicleClass.CORE]: 1.0,
  [VehicleClass.ELITE]: 1.6,
  [VehicleClass.PRESTIGE]: 2.4,
};

/** Round to 2 decimal places. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const fareService = {
  /**
   * Fast, deterministic, in-memory fare computation for the routing hot
   * path. No database, no network — only arithmetic. Takes microseconds.
   *
   * Returns a full itemized breakdown so the rider UI can render an
   * Uber-style fare card instantly.
   */
  computeFare(input: FareInput): FareBreakdown {
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

    // Default $/mile per package (used only when there is zero pricing data).
    let classBaseBarrier = 3.00;
    if (requestedClass === VehicleClass.ELITE) classBaseBarrier = 6.00;
    else if (requestedClass === VehicleClass.PRESTIGE) classBaseBarrier = 10.00;

    // Pull a price-per-mile for a driver row, falling back to the midpoint of
    // their stored range, then to the package default.
    const priceFor = (d: any): number => {
      if (d.price_per_mile) return Number(d.price_per_mile);
      const min = Number(d.price_range_min || (1.00 + xShift));
      const max = Number(d.price_range_max || (classBaseBarrier + xShift));
      return Math.round(((min + max) / 2) * 4) / 4;
    };

    const summarize = (prices: number[]) => {
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
      const onlineDrivers = await prisma.driver.findMany({
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
    const fleetDrivers = await prisma.driver.findMany({
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
function _finalizeEstimate(
  maxPricePerMile: number,
  medianPricePerMile: number,
  savingLikelihood: number,
  distanceMiles: number
): { maxFare: number; savingLikelihood: number; medianPricePerMile: number } {
  const calculatedMaxFare = maxPricePerMile * distanceMiles;
  const finalMaxFare = Math.round(Math.max(5.00, calculatedMaxFare) * 100) / 100;
  return {
    maxFare: finalMaxFare,
    savingLikelihood,
    medianPricePerMile: Math.round(medianPricePerMile * 100) / 100,
  };
}

