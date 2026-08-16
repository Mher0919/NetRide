import { Server } from 'socket.io';
export declare const matchingService: {
    /**
     * Dispatches a REQUESTED ride to the best eligible drivers, in-process.
     * Mirrors the semantics of the queue handler (matchRide.ts): status guard,
     * ride lock, staged radius search, sequential one-at-a-time offers, and
     * cancellation when no driver accepts after the retry budget.
     */
    findAndDispatch(io: Server, tripId: string, pickupLat: number, pickupLng: number, riderId?: string, favoritePriority?: boolean): Promise<void>;
};
