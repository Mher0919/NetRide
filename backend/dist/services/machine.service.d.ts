import { TripStatus } from '../types';
export declare class TripStateMachine {
    private static transitions;
    /**
     * Checks if a transition from currentStatus to nextStatus is valid.
     */
    static canTransition(currentStatus: TripStatus, nextStatus: TripStatus): boolean;
    /**
     * Validates a transition and throws an error if it's invalid.
     */
    static validateTransition(currentStatus: TripStatus, nextStatus: TripStatus): void;
}
