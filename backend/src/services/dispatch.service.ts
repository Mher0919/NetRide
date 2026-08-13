import { LocationsService } from '../modules/location/locations.service';
import { prisma, primaryPrisma } from './prisma.service';
import { mgetScoreFactors, refreshFromDb } from './driverScoreCache';
import { env } from '../config/env';

export interface ScoredDriver {
  id: string;
  score: number;
  distance: number;
  rating: number;
}

export class DispatchService {
  /**
   * Finds the best drivers for a ride request using a weighted scoring
   * algorithm. Every online, active driver is a candidate — there is no
   * vehicle-class or ride-preference filter.
   */
  static async getWeightedDrivers(
    pickup: { lat: number, lng: number },
    maxRadiusKm: number = 10,
    riderId?: string,
    favoritePriority: boolean = false
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
    }

    let drivers: DriverData[];

    if (env.LEGACY_DB_SCORE) {
      const dbDrivers = await primaryPrisma.driver.findMany({
        where: {
          user_id: { in: driverIds },
          is_active: true,
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
              cached_at: f.cached_at,
            };
          } catch {
            continue;
          }
        }
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
      
      const wDistance = favoritePriority ? 0.40 : 0.50;
      const wRating = favoritePriority ? 0.30 : 0.35;
      const wAcceptance = favoritePriority ? 0.15 : 0.15;
      const wFavorite = favoritePriority ? 0.15 : 0.00;

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

      // D. Favorite Score (only applied when favoritePriority is enabled)
      const isFavorite = favoritePriority ? favoriteDriverIds.includes(driver.user_id) : false;
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
      };
    });

    // 4. Sort by score descending
    return scoredDrivers.sort((a, b) => b.score - a.score);
  }
}
