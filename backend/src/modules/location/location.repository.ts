// backend/src/modules/location/location.repository.ts
import { redis, DRIVER_LOCATIONS_KEY } from '../../config/redis';
import { Location } from '../../types';

export const locationRepository = {
  /**
   * Updates the driver's current location in Redis using GEOADD.
   */
  async updateDriverLocation(driverId: string, location: Location): Promise<void> {
    await redis.geoadd(DRIVER_LOCATIONS_KEY, location.lng, location.lat, driverId);
  },

  /**
   * Retrieves the driver's current location from Redis.
   */
  async getDriverLocation(driverId: string): Promise<Location | null> {
    const pos = await redis.geopos(DRIVER_LOCATIONS_KEY, driverId);
    if (!pos || !pos[0]) return null;
    
    return {
      lng: parseFloat(pos[0][0]),
      lat: parseFloat(pos[0][1]),
    };
  },

  /**
   * Removes the driver's location from Redis (e.g., when they go offline).
   */
  async removeDriverLocation(driverId: string): Promise<void> {
    await redis.zrem(DRIVER_LOCATIONS_KEY, driverId);
  },

  /**
   * Finds nearby drivers within a certain radius.
   */
  async findNearbyDrivers(location: Location, radiusKm: number): Promise<string[]> {
    const results = await redis.georadius(
      DRIVER_LOCATIONS_KEY,
      location.lng,
      location.lat,
      radiusKm,
      'km'
    );
    return results as string[];
  }
};
