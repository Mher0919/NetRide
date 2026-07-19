// backend/src/services/vehicleEligibility.service.ts
//
// CENTRALIZED VEHICLE ELIGIBILITY ENGINE
// --------------------------------------
// This is the single source of truth for:
//   1. The ride-type tier model (CORE / ELITE / PRESTIGE, displayed as
//      NetRide Basic / NetRide Lux / NetRide Lux SUV in the UI).
//   2. Which ride types a given vehicle CLASS can serve (tier hierarchy).
//   3. Computing a vehicle's class from VERIFIED vehicle attributes
//      (luxury qualification, seating capacity, exterior/interior color, etc).
//
// Nothing else in the codebase should hardcode the tier hierarchy or the
// Lux-SUV rules. Dispatch, driver preferences, admin, and registration all
// delegate to this service so the logic stays in one place and is trivially
// extensible for future ride categories / programs.

import { VehicleClass } from '../types';

/**
 * Ordered, low-to-high list of ride types. Order defines the tier hierarchy:
 * a vehicle approved for a higher tier may also serve every lower tier.
 * To add a future ride category, insert it in the correct rank here — no
 * other code needs to change.
 */
export const RIDE_TYPE_ORDER: VehicleClass[] = [
  VehicleClass.CORE,
  VehicleClass.ELITE,
  VehicleClass.PRESTIGE,
];

/** UI-facing display label for each ride type. */
export const RIDE_TYPE_LABELS: Record<VehicleClass, string> = {
  [VehicleClass.CORE]: 'NetRide Basic',
  [VehicleClass.ELITE]: 'NetRide Lux',
  [VehicleClass.PRESTIGE]: 'NetRide Lux SUV',
};

export function rideTypeLabel(cls: VehicleClass): string {
  return RIDE_TYPE_LABELS[cls] ?? cls;
}

/** Canonical set of all supported ride types. */
export const ALL_RIDE_TYPES: VehicleClass[] = [...RIDE_TYPE_ORDER];

export interface VehicleAttributes {
  /** Verified luxury qualification (e.g. cataloged as a luxury program vehicle). */
  isLuxury?: boolean;
  /** Total passenger seating capacity (including driver where relevant). */
  seats?: number;
  /** Verified exterior color (normalized, e.g. "black"). */
  exteriorColor?: string | null;
  /** Verified interior color (normalized, e.g. "black"). */
  interiorColor?: string | null;
  /**
   * Optional additional gatekeepers for future programs
   * (commercial insurance, approved makes/models, city rules, model year...).
   * Each is a predicate evaluated by the rule engine.
   */
  commercialInsurance?: boolean;
  make?: string;
  model?: string;
  year?: number;
  region?: string;
}

export interface EligibilityResult {
  /** Highest class the vehicle qualifies for. */
  vehicleClass: VehicleClass;
  /** Every ride type the vehicle is eligible to receive (tier-inclusive). */
  eligibleRideTypes: VehicleClass[];
  /** Per-rule pass/fail detail, useful for admin transparency. */
  checks: { rule: string; passed: boolean; detail: string }[];
}

const BLACK = 'black';

function normalizeColor(c?: string | null): string | null {
  if (!c) return null;
  return c.trim().toLowerCase();
}

/**
 * Individual, composable eligibility rules. Each returns whether the vehicle
 * qualifies for the PRESTIGE (Lux SUV) tier. Lower tiers (ELITE, CORE) are
 * granted by progressively relaxing these requirements — see
 * `computeVehicleClass` which walks the rules from strictest to loosest.
 *
 * To add a future requirement (e.g. model-year floor, approved make list,
 * city-specific rule), append a rule here. The engine and all consumers
 * adapt automatically.
 */
export const LUX_SUV_RULES: {
  id: string;
  description: string;
  test: (a: VehicleAttributes) => boolean;
  detail: (a: VehicleAttributes) => string;
}[] = [
  {
    id: 'luxury_qualified',
    description: 'Luxury-qualified vehicle',
    test: (a) => !!a.isLuxury,
    detail: (a) => (a.isLuxury ? 'Vehicle is luxury-qualified' : 'Vehicle is not classified as luxury'),
  },
  {
    id: 'seven_seats',
    description: '7+ passenger seating capacity',
    test: (a) => typeof a.seats === 'number' && a.seats >= 7,
    detail: (a) => `Seating capacity: ${a.seats ?? 'unknown'} (requires >= 7)`,
  },
  {
    id: 'black_exterior',
    description: 'Black exterior',
    test: (a) => normalizeColor(a.exteriorColor) === BLACK,
    detail: (a) => `Exterior color: ${a.exteriorColor ?? 'unknown'} (requires black)`,
  },
  {
    id: 'black_interior',
    description: 'Black interior',
    test: (a) => normalizeColor(a.interiorColor) === BLACK,
    detail: (a) => `Interior color: ${a.interiorColor ?? 'unknown'} (requires black)`,
  },
];

/**
 * Returns the subset of LUX_SUV_RULES that passed for the given attributes.
 */
function evaluateLuxSuvRules(attrs: VehicleAttributes) {
  return LUX_SUV_RULES.map((r) => {
    const passed = r.test(attrs);
    return { rule: r.id, passed, detail: r.detail(attrs) };
  });
}

/**
 * Computes the vehicle class from VERIFIED attributes.
 *
 *   PRESTIGE (Lux SUV)  -> ALL Lux-SUV rules pass
 *   ELITE    (Lux)      -> luxury-qualified (meets the luxury gate; not a full SUV)
 *   CORE     (Basic)    -> everything else
 *
 * The hierarchy is intentionally derived from the rule results rather than
 * arbitrary per-vehicle user selections.
 */
export function computeVehicleClass(attrs: VehicleAttributes): EligibilityResult {
  const checks = evaluateLuxSuvRules(attrs);
  const passedIds = new Set(checks.filter((c) => c.passed).map((c) => c.rule));

  const allLuxSuvPass = passedIds.size === LUX_SUV_RULES.length;
  const luxuryQualified = passedIds.has('luxury_qualified');

  let vehicleClass: VehicleClass;
  if (allLuxSuvPass) {
    vehicleClass = VehicleClass.PRESTIGE;
  } else if (luxuryQualified) {
    vehicleClass = VehicleClass.ELITE;
  } else {
    vehicleClass = VehicleClass.CORE;
  }

  return {
    vehicleClass,
    eligibleRideTypes: getEligibleRideTypes(vehicleClass),
    checks,
  };
}

/**
 * Given a vehicle CLASS, returns every ride type it is eligible to serve.
 * A higher tier may also serve all lower tiers (tier inclusivity).
 *
 * This is the canonical tier map — previously duplicated in
 * `dispatch.service.ts` (getEligibleActiveClasses / getPotentialClasses)
 * and `driver.service.ts` (eligibilityMap). All callers now use this.
 */
export function getEligibleRideTypes(vehicleClass: VehicleClass | string): VehicleClass[] {
  const idx = RIDE_TYPE_ORDER.indexOf(vehicleClass as VehicleClass);
  if (idx < 0) return [VehicleClass.CORE];
  return RIDE_TYPE_ORDER.slice(0, idx + 1);
}

/** Inverse helper: which classes may fulfill a requested ride type. */
export function getClassesThatCanServe(requested: VehicleClass | string): VehicleClass[] {
  return getEligibleRideTypes(requested);
}

/**
 * Validates that a driver's chosen active class is within what their
 * vehicle class is eligible for. Replaces the old `eligibilityMap`.
 */
export function isClassEligibleForVehicle(
  vehicleClass: VehicleClass | string,
  requestedClass: VehicleClass | string,
): boolean {
  return getEligibleRideTypes(vehicleClass).includes(requestedClass as VehicleClass);
}
