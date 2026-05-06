// backend/src/types/index.ts

export enum UserRole {
  RIDER = 'RIDER',
  DRIVER = 'DRIVER'
}

export enum TripStatus {
  REQUESTED = 'REQUESTED',
  ACCEPTED = 'ACCEPTED',
  DRIVER_ARRIVING = 'DRIVER_ARRIVING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED'
}

export enum VehicleCategory {
  ECONOMY = 'ECONOMY',
  EXTRA = 'EXTRA',
  LUX = 'LUX',
  SUV_LUX = 'SUV_LUX',
  PREMIER = 'PREMIER'
}

export interface User {
  id: string;
  email: string;
  phone_number?: string;
  full_name: string;
  profile_image_url?: string;
  date_of_birth?: Date;
  role: UserRole;
  is_verified: boolean;
  is_active: boolean;
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
  pickup: Location & { address: string };
  destination: Location & { address: string };
  distance_km?: number;
  duration_minutes?: number;
  fare_amount?: number;
  requested_at: Date;
  accepted_at?: Date;
  started_at?: Date;
  completed_at?: Date;
}

export interface SocketEvents {
  // From Client
  'updateLocation': (loc: Location) => void;
  'requestRide': (data: { pickup: Location; destination: Location }) => void;
  'acceptTrip': (tripId: string) => void;
  
  // To Client
  'tripUpdate': (trip: Trip) => void;
  'newTripRequest': (trip: Trip) => void;
  'driverLocationUpdate': (loc: Location) => void;
  'error': (msg: string) => void;
}