import { Server } from 'socket.io';
export declare const matchingService: {
    findAndDispatch(io: Server, tripId: string, pickupLat: number, pickupLng: number): Promise<void>;
    dispatchToNextDriver(io: Server, tripId: string, drivers: {
        id: string;
        distance: number;
    }[], index: number): Promise<void>;
    handleDriverResponse(io: Server, driverId: string, tripId: string, accepted: boolean): Promise<void>;
};
