// backend/src/services/vehicleEligibility.service.ts
//
// VEHICLE ELIGIBILITY ENGINE — SINGLE RIDE TYPE
// ---------------------------------------------
// NetRide operates a single platform ride type ("NetRide Premium"). Every
// approved vehicle is eligible; there are no tiers, no class selection, and
// no driver ride-type preferences.
//
// The `VehicleClass` enum is retained for database compatibility and future
// expansion (ELITE / PRESTIGE / XL / LUXURY can be re-added later) but only
// CORE (NetRide Premium) is exposed to production code. Nothing else in the
// codebase hardcodes tier rules.

import { VehicleClass } from '../types';

/**
 * Ordered, low-to-high list of active ride types. Only NetRide Premium
 * (CORE) is live. Future ride categories are added here — no other code
 * needs to change.
 */
export const RIDE_TYPE_ORDER: VehicleClass[] = [VehicleClass.CORE];

/** UI-facing display label for each ride type. */
export const RIDE_TYPE_LABELS: Record<VehicleClass, string> = {
  [VehicleClass.CORE]: 'NetRide Premium',
  [VehicleClass.ELITE]: 'NetRide Premium',
  [VehicleClass.PRESTIGE]: 'NetRide Premium',
};

export function rideTypeLabel(cls: VehicleClass | string): string {
  return RIDE_TYPE_LABELS[cls as VehicleClass] ?? 'NetRide Premium';
}

/** Canonical set of all supported ride types. */
export const ALL_RIDE_TYPES: VehicleClass[] = [...RIDE_TYPE_ORDER];

export interface VehicleAttributes {
  /** Verified luxury qualification (retained for future programs). */
  isLuxury?: boolean;
  /** Total passenger seating capacity (retained for future programs). */
  seats?: number;
  /** Verified exterior color (retained for future programs). */
  exteriorColor?: string | null;
  /** Verified interior color (retained for future programs). */
  interiorColor?: string | null;
  /** Optional additional gatekeepers for future programs. */
  commercialInsurance?: boolean;
  make?: string;
  model?: string;
  year?: number;
  region?: string;
}

export interface EligibilityResult {
  /** Highest class the vehicle qualifies for (always CORE today). */
  vehicleClass: VehicleClass;
  /** Every ride type the vehicle is eligible to receive. */
  eligibleRideTypes: VehicleClass[];
  /** Per-rule pass/fail detail, useful for admin transparency. */
  checks: { rule: string; passed: boolean; detail: string }[];
}

/**
 * Computes the vehicle class from VERIFIED attributes. Every vehicle is
 * classified as CORE (NetRide Premium) — all vehicles are eligible.
 */
export function computeVehicleClass(attrs: VehicleAttributes): EligibilityResult {
  return {
    vehicleClass: VehicleClass.CORE,
    eligibleRideTypes: getEligibleRideTypes(VehicleClass.CORE),
    checks: [
      {
        rule: 'standard_ride',
        passed: true,
        detail: 'All approved vehicles are eligible for NetRide Premium',
      },
    ],
  };
}

/**
 * Given a vehicle CLASS, returns every ride type it is eligible to serve.
 * Only NetRide Premium is live, so every vehicle resolves to [CORE].
 */
export function getEligibleRideTypes(vehicleClass: VehicleClass | string): VehicleClass[] {
  return [VehicleClass.CORE];
}

/** Inverse helper: which classes may fulfill a requested ride type. */
export function getClassesThatCanServe(requested: VehicleClass | string): VehicleClass[] {
  return [VehicleClass.CORE];
}

/**
 * Validates that a driver's class is eligible for a ride type. Every
 * approved vehicle can serve NetRide Premium.
 */
export function isClassEligibleForVehicle(
  vehicleClass: VehicleClass | string,
  requestedClass: VehicleClass | string,
): boolean {
  return true;
}
