import { Trip, TripStatus } from '../../types';
export declare class RideRepository {
    static create(data: {
        rider_id: string;
        pickup_lat: number;
        pickup_lng: number;
        pickup_address: string;
        destination_lat: number;
        destination_lng: number;
        destination_address: string;
    }): Promise<Trip>;
    static findById(id: string): Promise<Trip | null>;
    static updateStatus(id: string, status: TripStatus, extra?: any): Promise<Trip>;
    static findByRiderId(riderId: string): Promise<Trip[]>;
    static findByDriverId(driverId: string): Promise<Trip[]>;
    static findCurrentByRiderId(riderId: string): Promise<Trip | null>;
    static findCurrentByDriverId(driverId: string): Promise<Trip | null>;
    static delete(id: string, userId: string): Promise<boolean>;
    private static mapToTrip;
}
