export declare enum UserRole {
    RIDER = "RIDER",
    DRIVER = "DRIVER",
    ADMIN = "ADMIN"
}
export declare enum TripStatus {
    REQUESTED = "REQUESTED",
    ACCEPTED = "ACCEPTED",
    DRIVER_ARRIVING = "DRIVER_ARRIVING",
    IN_PROGRESS = "IN_PROGRESS",
    COMPLETED = "COMPLETED",
    CANCELLED = "CANCELLED"
}
export declare enum VehicleClass {
    CORE = "CORE",
    ELITE = "ELITE",
    PRESTIGE = "PRESTIGE"
}
export declare enum VehicleCategory {
    ECONOMY = "ECONOMY",
    EXTRA = "EXTRA",
    LUX = "LUX",
    SUV_LUX = "SUV_LUX",
    PREMIER = "PREMIER"
}
export interface User {
    id: string;
    email: string;
    phone_number?: string;
    full_name: string;
    profile_image_url?: string;
    id_photo_front_url?: string;
    id_photo_back_url?: string;
    date_of_birth?: Date;
    role: UserRole;
    is_verified: boolean;
    is_active: boolean;
    verification_status?: string;
    onboarding_step?: number | null;
    phone_verified?: boolean;
    headshot_uploaded?: boolean;
    created_at: Date;
}
export interface DriverProfile {
    id: string;
    user_id: string;
    vehicle_make: string;
    vehicle_model: string;
    vehicle_year: number;
    vehicle_plate: string;
    vehicle_type: VehicleCategory;
    is_online: boolean;
    rating: number;
    total_trips: number;
}
export interface Location {
    lat: number;
    lng: number;
}
export interface Trip {
    id: string;
    rider_id: string;
    driver_id?: string;
    status: TripStatus;
    requested_class: VehicleClass;
    snapshot_rider_rating?: number;
    pickup: Location & {
        address: string;
    };
    destination: Location & {
        address: string;
    };
    distance_km?: number;
    duration_minutes?: number;
    fare_amount?: number;
    initial_max_fare?: number;
    saving_likelihood?: number;
    trajectory?: any;
    requested_at: Date;
    accepted_at?: Date;
    started_at?: Date;
    completed_at?: Date;
    cancelled_at?: Date;
    rider_info?: {
        name: string;
        email?: string;
        rating: number;
        total_rides: number;
    };
    driver_info?: {
        name: string;
        email?: string;
        rating: number;
        total_rides: number;
    };
}
export interface SocketEvents {
    'updateLocation': (loc: Location) => void;
    'requestRide': (data: {
        pickup: Location;
        destination: Location;
    }) => void;
    'acceptTrip': (tripId: string) => void;
    'tripUpdate': (trip: Trip) => void;
    'newTripRequest': (trip: Trip) => void;
    'driverLocationUpdate': (loc: Location) => void;
    'error': (msg: string) => void;
}
