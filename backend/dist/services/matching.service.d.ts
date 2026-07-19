import { Server } from 'socket.io';
import { VehicleClass } from '../types';
import { ScoredDriver } from './dispatch.service';
/** @deprecated Use BullMQ queue (matchQueue.add) instead. Kept for LEGACY_SYNC_MATCHING fallback. */
export declare const matchingService: {
    findAndDispatch(io: Server, tripId: string, pickupLat: number, pickupLng: number, requestedClass: VehicleClass, riderId?: string): Promise<void>;
    dispatchToNextDriver(io: Server, tripId: string, drivers: ScoredDriver[], index: number): Promise<void>;
    /**
     * Driver explicitly declined an incoming request in the parallel fan-out model.
     * Removes the driver from the dispatched set and updates metrics.
     */
    handleDecline(io: Server, tripId: string, driverId: string): Promise<void>;
};
