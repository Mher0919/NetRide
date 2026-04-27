// backend/src/services/machine.service.ts
import { TripStatus } from '../types';

export class TripStateMachine {
  private static transitions: Record<TripStatus, TripStatus[]> = {
    [TripStatus.REQUESTED]: [TripStatus.ACCEPTED, TripStatus.CANCELLED],
    [TripStatus.ACCEPTED]: [TripStatus.DRIVER_ARRIVING, TripStatus.CANCELLED],
    [TripStatus.DRIVER_ARRIVING]: [TripStatus.IN_PROGRESS, TripStatus.CANCELLED],
    [TripStatus.IN_PROGRESS]: [TripStatus.COMPLETED],
    [TripStatus.COMPLETED]: [],
    [TripStatus.CANCELLED]: [],
  };

  /**
   * Checks if a transition from currentStatus to nextStatus is valid.
   */
  static canTransition(currentStatus: TripStatus, nextStatus: TripStatus): boolean {
    const allowed = this.transitions[currentStatus];
    return allowed ? allowed.includes(nextStatus) : false;
  }

  /**
   * Validates a transition and throws an error if it's invalid.
   */
  static validateTransition(currentStatus: TripStatus, nextStatus: TripStatus): void {
    if (!this.canTransition(currentStatus, nextStatus)) {
      throw new Error(`Invalid trip status transition: ${currentStatus} -> ${nextStatus}`);
    }
  }
}
