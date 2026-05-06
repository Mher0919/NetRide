import { Location } from '../../types';
export declare const locationRepository: {
    /**
     * Updates the driver's current location in Redis using GEOADD.
     */
    updateDriverLocation(driverId: string, location: Location): Promise<void>;
    /**
     * Retrieves the driver's current location from Redis.
     */
    getDriverLocation(driverId: string): Promise<Location | null>;
    /**
     * Removes the driver's location from Redis (e.g., when they go offline).
     */
    removeDriverLocation(driverId: string): Promise<void>;
    /**
     * Finds nearby drivers within a certain radius.
     */
    findNearbyDrivers(location: Location, radiusKm: number): Promise<string[]>;
};
