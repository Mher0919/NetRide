import { LocationsService } from '../modules/location/locations.service';
import { prisma, primaryPrisma } from './prisma.service';
import { VehicleClass } from '../types';
import { redis } from '../config/redis';
import { mgetScoreFactors, refreshFromDb } from './driverScoreCache';
import { env } from '../config/env';

export interface ScoredDriver {
  id: string;
  score: number;
  distance: number;
  rating: number;
  activeClass: VehicleClass;
  pricePerMile?: number;
}

export class DispatchService {
  /**
   * Finds the best drivers for a ride request using a weighted scoring algorithm.
   */
  static async getWeightedDrivers(
    pickup: { lat: number, lng: number }, 
    requestedClass: VehicleClass,
    maxRadiusKm: number = 10,
    riderId?: string // Added riderId for favorites priority
  ): Promise<ScoredDriver[]> {
    // 1. Find nearby online drivers via Redis Geolocation
    const nearby = await LocationsService.findNearbyDrivers(pickup, maxRadiusKm);
    
    if (nearby.length === 0) return [];

    const driverIds = nearby.map((d: any) => d.id);

    // 2. Fetch driver operational details from DB or cache
    interface DriverData {
      user_id: string;
      rating: number;
      rating_count: number;
      acceptance_count: number;
      cancellation_count: number;
      last_cancellation_at: Date | null;
      total_rides: number;
      is_dangerous: boolean;
      is_flagged: boolean;
      price_per_mile: number | null;
      active_class: string;
    }

    let drivers: DriverData[];

    if (env.LEGACY_DB_SCORE) {
      const dbDrivers = await primaryPrisma.driver.findMany({
        where: {
          user_id: { in: driverIds },
          is_active: true,
          active_class: { in: this.getEligibleActiveClasses(requestedClass) },
        } as any,
        include: {
          user: { select: { rating: true, rating_count: true } },
        },
      });
      drivers = dbDrivers.map((d: any) => ({
        user_id: d.user_id,
        rating: Number(d.user?.rating || 5.0),
        rating_count: d.user?.rating_count || 0,
        acceptance_count: d.acceptance_count || 0,
        cancellation_count: d.cancellation_count || 0,
        last_cancellation_at: d.last_cancellation_at || null,
        total_rides: d.total_rides || 0,
        is_dangerous: d.is_dangerous || false,
        is_flagged: d.is_flagged || false,
        price_per_mile: d.price_per_mile ? Number(d.price_per_mile) : null,
        active_class: d.active_class || 'CORE',
      }));
    } else {
      const cachedFactors = await mgetScoreFactors(driverIds);
      drivers = [];
      for (const id of driverIds) {
        let factors = cachedFactors.get(id);
        if (!factors) {
          try {
            const f = await refreshFromDb(id);
            factors = {
              rating: f.rating,
              rating_count: f.rating_count,
              acceptance_count: f.acceptance_count,
              cancellation_count: f.cancellation_count,
              total_rides: f.total_rides,
              is_dangerous: f.is_dangerous,
              is_flagged: f.is_flagged,
              last_cancellation_at: f.last_cancellation_at,
              price_per_mile: f.price_per_mile,
              active_class: f.active_class,
              cached_at: f.cached_at,
            };
          } catch {
            continue;
          }
        }
        const eligibleActiveClasses = this.getEligibleActiveClasses(requestedClass).map(c => c.toString());
        if (!eligibleActiveClasses.includes(factors.active_class)) continue;
        drivers.push({
          user_id: id,
          rating: factors.rating,
          rating_count: factors.rating_count,
          acceptance_count: factors.acceptance_count,
          cancellation_count: factors.cancellation_count,
          last_cancellation_at: factors.last_cancellation_at ? new Date(factors.last_cancellation_at) : null,
          total_rides: factors.total_rides,
          is_dangerous: factors.is_dangerous,
          is_flagged: factors.is_flagged,
          price_per_mile: factors.price_per_mile,
          active_class: factors.active_class,
        });
      }
    }

    if (drivers.length === 0) return [];

    // Fetch Rider Favorites
    let favoriteDriverIds: string[] = [];
    if (riderId) {
      const favorites = await (prisma as any).favoriteDriver.findMany({
        where: { rider_id: riderId },
        select: { driver_id: true }
      });
      favoriteDriverIds = favorites.map((f: any) => f.driver_id);
    }

    // 3. Scoring Algorithm
    const scoredDrivers: ScoredDriver[] = drivers.map((driver: DriverData) => {
      const distanceInfo = nearby.find((n: any) => n.id === driver.user_id)!;
      const distance = (distanceInfo as any).distance;
      const rating = driver.rating;
      
      const wDistance = 0.40;   // 40% weight on distance
      const wRating = 0.30;     // 30% weight on driver rating
      const wAcceptance = 0.15; // 15% weight on acceptance/cancellation history
      const wFavorite = 0.15;   // 15% weight for favorite drivers

      // A. Distance Score (0.0 to 1.0)
      const distanceScore = Math.max(0, (maxRadiusKm - distance) / maxRadiusKm);

      // B. Rating Score (0.0 to 1.0)
      const ratingScore = rating / 5.0;

      // C. Acceptance/Reliability Score (0.0 to 1.0)
      const totalRequests = driver.acceptance_count + driver.cancellation_count;
      let reliabilityScore = 1.0;
      if (totalRequests > 0) {
        reliabilityScore = driver.acceptance_count / totalRequests;
      }
      
      if (driver.last_cancellation_at) {
        const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000);
        if (new Date(driver.last_cancellation_at) > fiveMinsAgo) {
          reliabilityScore *= 0.5;
        }
      }

      // D. Favorite Score
      const isFavorite = favoriteDriverIds.includes(driver.user_id);
      const favoriteScore = isFavorite ? 1.0 : 0.0;

      // Experience factor (rides completed)
      let experienceMultiplier = 1.0;
      if (driver.total_rides < 10) {
        experienceMultiplier = 0.9;
      } else if (driver.total_rides >= 100) {
        experienceMultiplier = 1.05;
      }

      // Penalties for dangerous driving (aggressive) or flagged accounts
      let feedbackMultiplier = 1.0;
      if (driver.is_dangerous) {
        feedbackMultiplier *= 0.5;
      }
      if (driver.is_flagged) {
        feedbackMultiplier *= 0.7;
      }

      const score = (
        (distanceScore * wDistance) + 
        (ratingScore * wRating) + 
        (reliabilityScore * wAcceptance) +
        (favoriteScore * wFavorite)
      ) * 100 * experienceMultiplier * feedbackMultiplier;

      return {
        id: driver.user_id,
        score,
        distance,
        rating,
        activeClass: driver.active_class as VehicleClass,
        pricePerMile: driver.price_per_mile || undefined,
      };
    });

    // 4. Sort by score descending, with lowest price as tie-breaker for equally close drivers with same rating
    return scoredDrivers.sort((a, b) => {
      const distanceDiff = Math.abs(a.distance - b.distance);
      const ratingDiff = Math.abs(a.rating - b.rating);

      // If "equally close" (distance diff < 100 meters / 0.1 km) and "same exact rating"
      if (distanceDiff < 0.1 && ratingDiff < 0.01) {
        const priceA = a.pricePerMile || 2.0;
        const priceB = b.pricePerMile || 2.0;
        if (Math.abs(priceA - priceB) > 0.01) {
          return priceA - priceB; // lowest price first (ascending)
        }
        return Math.random() - 0.5; // choose randomly
      }

      return b.score - a.score;
    });
  }

  /**
   * Returns a list of active classes that can fulfill a specific ride request class.
   */
  private static getEligibleActiveClasses(requested: VehicleClass): VehicleClass[] {
    if (requested === VehicleClass.PRESTIGE) {
      return [VehicleClass.PRESTIGE];
    }
    if (requested === VehicleClass.ELITE) {
      return [VehicleClass.ELITE, VehicleClass.PRESTIGE];
    }
    return [VehicleClass.CORE, VehicleClass.ELITE, VehicleClass.PRESTIGE];
  }

  /**
   * Demand-based Recommendations
   */
  static async getRecommendationsForDriver(driverId: string) {
    const driver: any = await prisma.driver.findUnique({
      where: { user_id: driverId },
      include: { 
        vehicles: {
          include: { vehicle: true }
        }
      }
    });

    if (!driver || !driver.vehicles[0]) return null;

    const vehicleClass = driver.vehicles[0].vehicle?.service_class as VehicleClass || VehicleClass.CORE;    
    
    const potentialClasses = this.getPotentialClasses(vehicleClass);
    if (potentialClasses.length <= 1) return null;

    const stats = await Promise.all(potentialClasses.map(async (cls) => {
      const demandCount = await redis.get(`demand:count:${cls}`) || '0';
      const supplyCount = await redis.get(`supply:count:${cls}`) || '1';
      return {
        class: cls,
        ratio: parseInt(demandCount) / parseInt(supplyCount)
      };
    }));

    const best = stats.sort((a, b) => b.ratio - a.ratio)[0];

    if (best.ratio > 1.2 && (best.class as any) !== driver.active_class) {
      return {
        recommended_class: best.class,
        reason: `High demand for ${this.getFriendlyClassName(best.class as any)} in your area right now.`
      };
    }

    return null;
  }

  private static getPotentialClasses(vehicleClass: VehicleClass): VehicleClass[] {
    if (vehicleClass === VehicleClass.PRESTIGE) return [VehicleClass.CORE, VehicleClass.ELITE, VehicleClass.PRESTIGE];
    if (vehicleClass === VehicleClass.ELITE) return [VehicleClass.CORE, VehicleClass.ELITE];
    return [VehicleClass.CORE];
  }

  private static getFriendlyClassName(cls: VehicleClass): string {
    switch(cls) {
      case VehicleClass.CORE: return 'NetRide CORE';
      case VehicleClass.ELITE: return 'NetRide ELITE';
      case VehicleClass.PRESTIGE: return 'NetRide PRESTIGE';
      default: return 'Standard';
    }
  }
}
