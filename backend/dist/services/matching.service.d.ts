import { Server } from 'socket.io';
import { VehicleClass } from '../types';
import { ScoredDriver } from './dispatch.service';
export declare const matchingService: {
    findAndDispatch(io: Server, tripId: string, pickupLat: number, pickupLng: number, requestedClass: VehicleClass, riderId?: string): Promise<void>;
    dispatchToNextDriver(io: Server, tripId: string, drivers: ScoredDriver[], index: number): Promise<void>;
    /**
     * Driver explicitly declined an incoming request. Move immediately to the
     * next-best driver without waiting for the accept timeout to elapse.
     */
    handleDecline(io: Server, tripId: string, driverId: string): Promise<void>;
};
