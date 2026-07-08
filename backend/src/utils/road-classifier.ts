// backend/src/utils/road-classifier.ts
//
// Centralized helpers for inferring road class + speed limit from raw
// OSRM step metadata. OSRM populates `ref` (e.g. "I-405", "US-101"),
// `name`, and `mode`. Speed limits are inconsistently populated upstream,
// so we layer three sources in priority order:
//   1. step.speed_limit (when present, kph)
//   2. road-class default (freeway / arterial / local / residential)
//   3. conservative fallback (30 mph local)
//
// All return values are in **mph** to match what the GPS sensor reports.

const KMH_TO_MPH = 0.621371;

/**
 * Order matters — these regexes are evaluated top-down and the first match
 * wins, so freeway patterns must come before the generic road patterns.
 */
const FREEWAY_PATTERNS: RegExp[] = [
  /\bI-\d+\b/i,
  /\bUS-\d+\b/i,
  /\bSR-\d+\b/i,
  /\bCA-\d+\b/i,
  /\bInterstate\b/i,
  /\bFwy\b/i,
  /\bFreeway\b/i,
  /\bExpressway\b/i,
];

/**
 * Classify a road from its OSRM step. Returns the class key used to
 * pick a speed-limit default when OSRM doesn't provide one.
 */
export function classifyRoad(step: { ref?: string | null; name?: string | null; mode?: string | null }): {
  isFreeway: boolean;
  isArterial: boolean;
  classKey: 'freeway' | 'arterial' | 'local' | 'residential';
} {
  const ref = (step.ref || '').toString();
  const name = (step.name || '').toString();

  if (FREEWAY_PATTERNS.some(rx => rx.test(ref) || rx.test(name))) {
    return { isFreeway: true, isArterial: true, classKey: 'freeway' };
  }

  // California arterial naming: "Wilshire Blvd", "Sunset Blvd", numbered
  // state routes without an "I-" prefix, "Pacific Coast Hwy".
  const arterialHints = /\b(Blvd|Boulevard|Avenue|Ave|Street|St|Hwy|Highway|Parkway|Pkwy|Road|Rd|Drive|Dr)\b/i;
  if (arterialHints.test(name)) {
    return { isFreeway: false, isArterial: true, classKey: 'arterial' };
  }

  // "Lane", "Way", "Court", "Place", "Loop", "Trail" → residential.
  const residentialHints = /\b(Lane|Ln|Way|Court|Ct|Place|Pl|Loop|Trail|Trl)\b/i;
  if (residentialHints.test(name)) {
    return { isFreeway: false, isArterial: false, classKey: 'residential' };
  }

  // No identifying tokens — treat as a local road.
  return { isFreeway: false, isArterial: false, classKey: 'local' };
}

const MPH_DEFAULTS: Record<string, number> = {
  freeway: 65,
  arterial: 45,
  local: 30,
  residential: 25,
};

/**
 * Resolve a speed limit in mph. Prefers OSRM-provided `speed_limit`
 * (which is in kph on some OSRM builds); falls back to the road-class
 * default; ultimately to a 30 mph conservative local limit.
 */
export function resolveSpeedLimitMph(step: {
  ref?: string | null;
  name?: string | null;
  speed_limit?: number | string | null;
}): number {
  const raw = step.speed_limit;
  if (raw !== undefined && raw !== null && raw !== '') {
    const num = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
    if (Number.isFinite(num) && num > 0) {
      // OSRM speed_limit is in m/s on some builds, kph on others.
      // >30 m/s is implausible; >200 kph is plausible for a German
      // autobahn but impossible in California. We treat anything in
      // [10, 35] as m/s and convert, and anything >35 as kph.
      if (num >= 10 && num <= 35) {
        return Math.round(num * KMH_TO_MPH * 3.6); // m/s → km/h → mph
      }
      return Math.round(num * KMH_TO_MPH);
    }
  }
  const cls = classifyRoad(step);
  return MPH_DEFAULTS[cls.classKey];
}

/**
 * Flatten OSRM steps into a per-step record the client and the
 * speeding detector both consume. Keeps backwards compat: `name`,
 * `distance`, `maneuver` are unchanged. Adds:
 *   - ref, mode
 *   - isFreeway, classKey
 *   - speedLimitMph (resolved)
 *   - lanes[] (parsed from intersections)
 */
export function enrichSteps(steps: any[]): any[] {
  if (!Array.isArray(steps)) return [];
  return steps.map(step => {
    const cls = classifyRoad(step);
    const lanes = extractLanes(step);
    return {
      ...step,
      ref: step.ref ?? null,
      mode: step.mode ?? 'driving',
      isFreeway: cls.isFreeway,
      classKey: cls.classKey,
      speedLimitMph: resolveSpeedLimitMph(step),
      lanes,
    };
  });
}

/**
 * Pull lane guidance out of the first intersection that has lanes. The
 * OSRM step shape: `step.intersections[0].lanes[].{valid, indications}`.
 *
 * Returns `[{ indication: 'left'|'right'|'straight'|..., valid: bool }]`
 * so the driver app's LaneGuidance widget can render icons.
 */
export function extractLanes(step: any): Array<{ indication: string; valid: boolean }> {
  const intersections = step?.intersections;
  if (!Array.isArray(intersections) || intersections.length === 0) return [];
  const lanes = intersections[0]?.lanes;
  if (!Array.isArray(lanes) || lanes.length === 0) return [];

  const out: Array<{ indication: string; valid: boolean }> = [];
  for (const lane of lanes) {
    const indications: string[] = Array.isArray(lane?.indications) ? lane.indications : [];
    const primary = pickPrimaryIndication(indications);
    if (!primary) continue;
    out.push({ indication: primary, valid: lane?.valid === true });
  }
  return out;
}

/**
 * "straight" beats a turn when both are valid; left/right beats "sharp
 * left/right" by truncating. The driver's lane guidance only needs one
 * icon per lane.
 */
function pickPrimaryIndication(indications: string[]): string | null {
  if (indications.length === 0) return null;
  // Order: prefer the more specific direction.
  const order = ['left', 'right', 'straight', 'sharp left', 'sharp right', 'slight left', 'slight right', 'uturn'];
  for (const candidate of order) {
    const match = indications.find(i => i.toLowerCase() === candidate);
    if (match) return match;
  }
  return indications[0]?.toLowerCase() ?? null;
}