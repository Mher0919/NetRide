"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TripStateMachine = void 0;
// backend/src/services/machine.service.ts
const types_1 = require("../types");
class TripStateMachine {
    /**
     * Checks if a transition from currentStatus to nextStatus is valid.
     */
    static canTransition(currentStatus, nextStatus) {
        const allowed = this.transitions[currentStatus];
        return allowed ? allowed.includes(nextStatus) : false;
    }
    /**
     * Validates a transition and throws an error if it's invalid.
     */
    static validateTransition(currentStatus, nextStatus) {
        if (!this.canTransition(currentStatus, nextStatus)) {
            throw new Error(`Invalid trip status transition: ${currentStatus} -> ${nextStatus}`);
        }
    }
}
exports.TripStateMachine = TripStateMachine;
TripStateMachine.transitions = {
    [types_1.TripStatus.REQUESTED]: [types_1.TripStatus.ACCEPTED, types_1.TripStatus.CANCELLED],
    [types_1.TripStatus.ACCEPTED]: [types_1.TripStatus.DRIVER_ARRIVING, types_1.TripStatus.CANCELLED],
    [types_1.TripStatus.DRIVER_ARRIVING]: [types_1.TripStatus.IN_PROGRESS, types_1.TripStatus.CANCELLED],
    [types_1.TripStatus.IN_PROGRESS]: [types_1.TripStatus.COMPLETED],
    [types_1.TripStatus.COMPLETED]: [],
    [types_1.TripStatus.CANCELLED]: [],
};
//# sourceMappingURL=machine.service.js.map