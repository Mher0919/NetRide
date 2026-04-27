// backend/src/modules/location/locations.service.ts
import { redis, DRIVER_LOCATIONS_KEY } from '../../config/redis';
import { Location } from '../../types';

export class LocationsService {
  /**
   * Updates a driver's real-time location in Redis
   */
  static async updateDriverLocation(driverId: string, loc: Location): Promise<void> {
    await redis.geoadd(DRIVER_LOCATIONS_KEY, loc.lng, loc.lat, driverId);
    // Optionally set an expiry for stale locations if using a different structure, 
    // but GEO sets are persistent. We can use a separate TTL key if needed.
  }

  /**
   * Finds nearby online drivers within a radius
   * @returns Array of driver IDs and their distances
   */
  static async findNearbyDrivers(loc: Location, radiusKm: number): Promise<{ id: string; distance: number }[]> {
    console.log(`[GEO] Searching nearby drivers. Pickup: lat=${loc.lat}, lng=${loc.lng}, radius=${radiusKm}km`);
    
    // Safety check for very small distances or same-location matching
    const searchRadius = Math.max(radiusKm, 0.1); // Min 100 meters

    try {
      const results = await redis.georadius(
        DRIVER_LOCATIONS_KEY,
        loc.lng,
        loc.lat,
        searchRadius,
        'km',
        'WITHDIST',
        'ASC'
      );

      console.log(`[GEO] Redis raw results:`, results);

      if (!results || results.length === 0) {
        // Double check all drivers in Redis for debugging
        const allDrivers = await redis.zrange(DRIVER_LOCATIONS_KEY, 0, -1);
        console.log(`[GEO] No drivers found in radius. Total drivers in Redis: ${allDrivers.length}`);
      }

      return (results as any[]).map(([id, distance]) => ({
        id,
        distance: parseFloat(distance),
      }));
    } catch (error) {
      console.error(`[GEO] Error in georadius:`, error);
      return [];
    }
  }

  /**
   * Removes a driver from the online tracking (e.g., when they go offline)
   */
  static async removeDriverLocation(driverId: string): Promise<void> {
    await redis.zrem(DRIVER_LOCATIONS_KEY, driverId);
  }

  static async getDriverLocation(driverId: string): Promise<Location | null> {
    const pos = await redis.geopos(DRIVER_LOCATIONS_KEY, driverId);
    if (pos && pos[0]) {
      return {
        lng: parseFloat(pos[0][0]),
        lat: parseFloat(pos[0][1]),
      };
    }
    return null;
  }
}