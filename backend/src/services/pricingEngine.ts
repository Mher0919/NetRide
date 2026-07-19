// backend/src/services/pricingEngine.ts
//
// CENTRALIZED PRICING ENGINE — SINGLE SOURCE OF TRUTH
//
// Every client (driver app, rider app, admin, matching, dispatch) must consume
// the values produced here. No other module is allowed to compute a driver's
// allowed price range. This keeps the pricing logic deterministic,
// explainable, and maintainable.
//
// Design goals (per engineering requirements):
//  - Deterministic: identical inputs always yield identical outputs. No RNG.
//  - Explainable:    each adjustment carries a human-readable reason.
//  - Personalized:   ranges differ per driver based on real performance data.
//  - Evolving:       ranges shift as the driver's stats and market change.

// Prisma/Redis are imported lazily inside getMarketConditions so the pure
// pricing functions (computeDriverRange, getCooldownState, etc.) remain
// importable & unit-testable without a live database/redis connection.
let _redis: any;
let _prisma: any;
async function _loadDeps() {
  if (!_redis || !_prisma) {
    const redisMod = await import('../config/redis');
    const prismaMod = await import('./prisma.service');
    _redis = redisMod.redis;
    _prisma = prismaMod.prisma;
  }
  return { redis: _redis, prisma: _prisma, DRIVER_LOCATIONS_KEY: (await import('../config/redis')).DRIVER_LOCATIONS_KEY };
}

/** Minimum amount of time a driver must wait between price changes (4h). */
export const PRICE_COOLDOWN_MS = 4 * 60 * 60 * 1000;

/** Hard floor for any price per mile on the platform. */
export const ABSOLUTE_MIN_PRICE = 1.0;

/** Vehicle classes (kept as plain string union to avoid enum-type drift). */
export type VehicleClassValue = 'CORE' | 'ELITE' | 'PRESTIGE' | null;

/** Snap a value to the nearest $0.25 (the platform pricing increment). */
export function snapToQuarter(value: number): number {
  return Math.round(value * 4) / 4;
}

export interface PricingInputs {
  user_id: string;
  active_class: VehicleClassValue;
  rating: number;
  total_rides: number;
  acceptance_count: number;
  cancellation_count: number;
  is_dangerous: boolean;
  is_flagged: boolean;
  last_cancellation_at: Date | null;
}

export interface MarketConditions {
  /** Global additive shift (in $/mile) from demand/supply + time-of-day. */
  xShift: number;
  demandRatio: number;
  onlineDrivers: number;
  activeRequests: number;
  /** Hour of day (0-23) used for the deterministic demand curve. */
  hourOfDay: number;
  reasons: string[];
}

export interface DriverRange {
  price_range_min: number;
  price_range_max: number;
  recommended_price: number;
  /** Explanation of how the range was derived (for audits/admin). */
  explanation: string[];
}

export interface CooldownState {
  cooldownActive: boolean;
  /** Epoch ms when the driver may change price again (or null if inactive). */
  cooldownUntil: number | null;
  /** Ms remaining until the cooldown ends (0 if inactive). */
  remainingMs: number;
}

// ---------------------------------------------------------------------------
// 1. MARKET CONDITIONS  (deterministic — derived from real platform signals)
// ---------------------------------------------------------------------------

/**
 * Computes global market conditions WITHOUT any randomness.
 *
 * Replaces the previous Math.random()-based weather/traffic simulation.
 * The "shift" is now a deterministic function of:
 *   - actual demand/supply ratio (active ride requests vs. online drivers)
 *   - a smooth time-of-day demand curve (rush hours raise prices)
 */
export async function getMarketConditions(now: Date = new Date()): Promise<MarketConditions> {
  const reasons: string[] = [];
  const { prisma, redis, DRIVER_LOCATIONS_KEY } = await _loadDeps();

  const activeRequestsRes = (await prisma.$queryRawUnsafe(
    "SELECT COUNT(*)::int as count FROM rides WHERE created_at > NOW() - INTERVAL '30 minutes'"
  )) as any[];
  const activeRequests = Number(activeRequestsRes?.[0]?.count ?? 0);

  const onlineDrivers = await redis.zcard(DRIVER_LOCATIONS_KEY);

  const demandRatio = activeRequests / Math.max(1, onlineDrivers);

  const hourOfDay = now.getUTCHours();

  // Time-of-day demand curve (0.0 .. 1.0). Peaks at ~8h and ~18h.
  const morning = Math.exp(-Math.pow(hourOfDay - 8, 2) / 8);
  const evening = Math.exp(-Math.pow(hourOfDay - 18, 2) / 8);
  const timeDemand = Math.min(1, morning + evening); // 0..1

  let demandShift = 0.0;
  if (demandRatio >= 1.5) {
    demandShift = 0.5;
    reasons.push('High demand/supply ratio (>=1.5) → +$0.50/mi');
  } else if (demandRatio <= 0.5) {
    demandShift = -0.25;
    reasons.push('Low demand/supply ratio (<=0.5) → -$0.25/mi');
  } else {
    reasons.push(`Balanced demand/supply ratio (${demandRatio.toFixed(2)}) → no shift`);
  }

  // Smooth time-of-day pressure, scaled to at most +/-$0.75.
  const timeShift = (timeDemand - 0.4) * 1.25;
  if (timeShift > 0.01) {
    reasons.push(`Peak time-of-day demand → +$${timeShift.toFixed(2)}/mi`);
  } else if (timeShift < -0.01) {
    reasons.push(`Off-peak time-of-day → ${timeShift.toFixed(2)}/mi`);
  }

  const xShift = snapToQuarter(demandShift + timeShift);
  if (reasons.length === 0) reasons.push('Neutral market conditions → no shift');

  return {
    xShift,
    demandRatio,
    onlineDrivers,
    activeRequests,
    hourOfDay,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// 2. COOLDOWN  (server-time derived; never trusts the client clock)
// ---------------------------------------------------------------------------

export function getCooldownState(priceLastChanged: Date | string | null, now: number = Date.now()): CooldownState {
  if (!priceLastChanged) {
    return { cooldownActive: false, cooldownUntil: null, remainingMs: 0 };
  }
  const last = new Date(priceLastChanged).getTime();
  const elapsed = now - last;
  const remaining = PRICE_COOLDOWN_MS - elapsed;
  if (remaining > 0) {
    return {
      cooldownActive: true,
      cooldownUntil: last + PRICE_COOLDOWN_MS,
      remainingMs: remaining,
    };
  }
  return { cooldownActive: false, cooldownUntil: null, remainingMs: 0 };
}

/** True when the driver is allowed to change price right now. */
export function isPriceChangeAllowed(priceLastChanged: Date | string | null, now: number = Date.now()): boolean {
  return !getCooldownState(priceLastChanged, now).cooldownActive;
}

// ---------------------------------------------------------------------------
// 3. PER-DRIVER RANGE  (the heart of the personalized pricing engine)
// ---------------------------------------------------------------------------

/**
 * Calculates a driver's allowed [min, max] and recommended price.
 *
 * Inputs (all real, stored data):
 *   - rating, total_rides, acceptance/cancellation counts
 *   - flagged / dangerous status
 *   - recency of last cancellation
 *   - vehicle class (base barrier)
 *   - live market conditions (xShift)
 *
 * The function is PURE and DETERMINISTIC: same inputs → same outputs.
 */
export function computeDriverRange(
  inputs: PricingInputs,
  market: MarketConditions
): DriverRange {
  const explanation: string[] = [];

  // ---- Base barrier by vehicle class -------------------------------------
  let baseBarrier = 3.0; // CORE
  if (inputs.active_class === 'ELITE') baseBarrier = 6.0;
  else if (inputs.active_class === 'PRESTIGE') baseBarrier = 10.0;
  explanation.push(`Base barrier for ${inputs.active_class ?? 'CORE'} class: $${baseBarrier.toFixed(2)}/mi`);

  let multiplier = 1.0;

  // ---- Rating adjustment --------------------------------------------------
  const rating = Number.isFinite(inputs.rating) ? inputs.rating : 5.0;
  if (rating < 4.0) {
    multiplier *= 0.5;
    explanation.push(`Low rating (${rating.toFixed(2)} < 4.0) → 50% barrier reduction`);
  } else if (rating < 4.5) {
    multiplier *= 0.75;
    explanation.push(`Below-par rating (${rating.toFixed(2)} < 4.5) → 25% barrier reduction`);
  } else if (rating < 4.8) {
    multiplier *= 0.9;
    explanation.push(`Good-but-not-great rating (${rating.toFixed(2)} < 4.8) → 10% barrier reduction`);
  } else {
    explanation.push(`Excellent rating (${rating.toFixed(2)} >= 4.8) → no barrier reduction`);
  }

  // ---- Safety / trust flags ----------------------------------------------
  if (inputs.is_dangerous) {
    multiplier *= 0.5;
    explanation.push('Dangerous-driving flag → 50% barrier reduction');
  }
  if (inputs.is_flagged) {
    multiplier *= 0.7;
    explanation.push('General flag → 30% barrier reduction');
  }

  // ---- Experience ---------------------------------------------------------
  const totalRides = inputs.total_rides || 0;
  if (totalRides < 10) {
    multiplier *= 0.9;
    explanation.push(`Inexperienced (${totalRides} < 10 rides) → 10% barrier reduction`);
  } else if (totalRides >= 500) {
    multiplier *= 1.05;
    explanation.push(`Veteran driver (${totalRides} >= 500 rides) → 5% barrier bonus`);
  }

  // ---- Reliability: acceptance vs cancellation ---------------------------
  const accept = inputs.acceptance_count || 0;
  const cancel = inputs.cancellation_count || 0;
  const totalDecisions = accept + cancel;
  if (totalDecisions > 0) {
    const cancellationRate = cancel / totalDecisions;
    if (cancellationRate > 0.2) {
      multiplier *= 0.85;
      explanation.push(`High cancellation rate (${(cancellationRate * 100).toFixed(0)}% > 20%) → 15% barrier reduction`);
    } else if (cancellationRate < 0.05 && accept > 20) {
      multiplier *= 1.05;
      explanation.push(`Strong reliability (low cancellation) → 5% barrier bonus`);
    }

    const acceptanceRate = accept / totalDecisions;
    if (acceptanceRate > 0.9 && accept > 20) {
      multiplier *= 1.05;
      explanation.push(`High acceptance rate (${(acceptanceRate * 100).toFixed(0)}% > 90%) → 5% barrier bonus`);
    }
  }

  // ---- Recent cancellation penalty ---------------------------------------
  if (inputs.last_cancellation_at) {
    const daysSince = (Date.now() - new Date(inputs.last_cancellation_at).getTime()) / 86_400_000;
    if (daysSince < 7) {
      multiplier *= 0.95;
      explanation.push('Cancellation within last 7 days → 5% barrier reduction');
    }
  }

  const baseBarrierAdjusted = baseBarrier * multiplier;
  explanation.push(`Adjusted max barrier: $${baseBarrierAdjusted.toFixed(2)}/mi`);

  // ---- Apply market shift & clamp ----------------------------------------
  let min = ABSOLUTE_MIN_PRICE + market.xShift;
  let max = baseBarrierAdjusted + market.xShift;

  min = snapToQuarter(min);
  max = snapToQuarter(max);

  if (min < ABSOLUTE_MIN_PRICE) min = ABSOLUTE_MIN_PRICE;
  if (max - min < 2.0) max = min + 2.0; // enforce a usable $2.00 band

  // ---- Recommended price --------------------------------------------------
  const demandFactor = Math.min(1.0, Math.max(0.0, market.demandRatio / 2.0));
  let recommended = snapToQuarter(min + (max - min) * demandFactor);
  if (recommended < min) recommended = min;
  if (recommended > max) recommended = max;

  explanation.push(`Market shift xShift=$${market.xShift.toFixed(2)}/mi (demand ratio ${market.demandRatio.toFixed(2)})`);
  explanation.push(`Final range: $${min.toFixed(2)} .. $${max.toFixed(2)}/mi, recommended $${recommended.toFixed(2)}/mi`);

  return {
    price_range_min: min,
    price_range_max: max,
    recommended_price: recommended,
    explanation,
  };
}

/**
 * Clamps a driver's current chosen price into the (possibly new) allowed
 * range. If no price is set yet, the recommended/mid price is assigned.
 */
export function resolveCurrentPrice(
  currentPrice: number | null,
  range: DriverRange
): number {
  if (currentPrice === null || Number.isNaN(currentPrice)) {
    return snapToQuarter((range.price_range_min + range.price_range_max) / 2);
  }
  return Math.max(range.price_range_min, Math.min(range.price_range_max, currentPrice));
}
