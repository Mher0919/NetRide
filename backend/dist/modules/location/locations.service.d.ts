import { Location } from '../../types';
export declare class LocationsService {
    /**
     * Updates a driver's real-time location in Redis
     */
    static updateDriverLocation(driverId: string, loc: Location): Promise<void>;
    /**
     * Finds nearby online drivers within a radius
     * @returns Array of driver IDs and their distances
     */
    static findNearbyDrivers(loc: Location, radiusKm: number): Promise<{
        id: string;
        distance: number;
    }[]>;
    /**
     * Removes a driver from the online tracking (e.g., when they go offline)
     */
    static removeDriverLocation(driverId: string): Promise<void>;
    static getDriverLocation(driverId: string): Promise<Location | null>;
}
