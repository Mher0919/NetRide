import { DriverProfile, VehicleCategory } from '../../types';
export declare class DriverRepository {
    static findByUserId(userId: string): Promise<DriverProfile | null>;
    static create(data: {
        user_id: string;
        vehicle_make: string;
        vehicle_model: string;
        vehicle_year: number;
        vehicle_plate: string;
        vehicle_type: VehicleCategory;
    }): Promise<DriverProfile>;
    static updateOnlineStatus(userId: string, isOnline: boolean): Promise<void>;
}
