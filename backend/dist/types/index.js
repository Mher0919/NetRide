"use strict";
// backend/src/types/index.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.VehicleCategory = exports.TripStatus = exports.UserRole = void 0;
var UserRole;
(function (UserRole) {
    UserRole["RIDER"] = "RIDER";
    UserRole["DRIVER"] = "DRIVER";
})(UserRole || (exports.UserRole = UserRole = {}));
var TripStatus;
(function (TripStatus) {
    TripStatus["REQUESTED"] = "REQUESTED";
    TripStatus["ACCEPTED"] = "ACCEPTED";
    TripStatus["DRIVER_ARRIVING"] = "DRIVER_ARRIVING";
    TripStatus["IN_PROGRESS"] = "IN_PROGRESS";
    TripStatus["COMPLETED"] = "COMPLETED";
    TripStatus["CANCELLED"] = "CANCELLED";
})(TripStatus || (exports.TripStatus = TripStatus = {}));
var VehicleCategory;
(function (VehicleCategory) {
    VehicleCategory["ECONOMY"] = "ECONOMY";
    VehicleCategory["EXTRA"] = "EXTRA";
    VehicleCategory["LUX"] = "LUX";
    VehicleCategory["SUV_LUX"] = "SUV_LUX";
    VehicleCategory["PREMIER"] = "PREMIER";
})(VehicleCategory || (exports.VehicleCategory = VehicleCategory = {}));
//# sourceMappingURL=index.js.map