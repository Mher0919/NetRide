import { Trip, Location } from '../../types';
export declare class RideService {
    static rateRide(data: {
        ride_id: string;
        rider_id: string;
        rating: number;
        review_text?: string;
    }): Promise<any>;
    static requestRide(riderId: string, pickup: Location & {
        address: string;
    }, destination: Location & {
        address: string;
    }): Promise<Trip>;
    static acceptTrip(tripId: string, driverId: string): Promise<Trip>;
    static updateTripStatus(tripId: string, status: any): Promise<Trip>;
    static cancelTrip(tripId: string): Promise<Trip>;
    static getHistory(userId: string, role: string): Promise<Trip[]>;
    static getCurrentRide(userId: string, role: string): Promise<Trip | null>;
    static deleteHistory(rideId: string, userId: string): Promise<boolean>;
}
