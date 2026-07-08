import { Trip, Location, VehicleClass } from '../../types';
export declare class RideService {
    static rateRide(data: {
        ride_id: string;
        rater_id: string;
        rating: number;
        review_text?: string;
    }): Promise<any>;
    static requestRide(riderId: string, pickup: Location & {
        address: string;
    }, destination: Location & {
        address: string;
    }, requestedClass?: VehicleClass, scheduledAt?: Date, isScheduled?: boolean): Promise<Trip>;
    static acceptTrip(tripId: string, driverId: string): Promise<Trip>;
    static updateTripStatus(tripId: string, status: any, userId: string): Promise<Trip>;
    static cancelTrip(tripId: string, userId: string): Promise<Trip>;
    static getHistory(userId: string, role: string): Promise<Trip[]>;
    static getCurrentRide(userId: string, role: string): Promise<Trip | null>;
    static deleteHistory(rideId: string, userId: string): Promise<boolean>;
}
