// backend/src/services/pricing.service.ts
//
// CENTRAL PRICING ENGINE — SINGLE SOURCE OF TRUTH FOR ALL RIDE PRICING
// --------------------------------------------------------------------
// Every client (rider app, driver app, admin, dispatch) consumes the values
// produced here. No other module may compute a fare. Driver-controlled
// pricing has been removed — the platform owns pricing end to end.
//
// Design goals:
//  - Config-driven:  all rates live in the `pricing_configurations` table
//                    (singleton row, id = 1) with a short in-memory cache.
//  - Deterministic:  identical inputs always yield identical outputs.
//  - Explainable:    every multiplier carries a human-readable reason.
//  - Fast:           the routing hot path never touches the DB or Redis —
//                    config + market conditions are cached in memory and
//                    refreshed by a periodic job.
//  - Snapshot-able:  every ride persists a price snapshot (distance, ETA,
//                    multiplier breakdown, config, final fare) so the fare
//                    quoted at request time is the fare charged at accept
//                    time — booking, payout, and payment all agree.

import { pool } from '../config/database';
import { redis, DRIVER_LOCATIONS_KEY } from '../config/redis';

// ---------------------------------------------------------------------------
// 1. CONFIG
// ---------------------------------------------------------------------------

export interface PricingConfig {
  /** Flat fare per ride (USD). */
  base_fare: number;
  /** Rate per kilometer (USD). */
  per_km_rate: number;
  /** Rate per minute of trip time (USD). */
  per_minute_rate: number;
  /** Floor below which a ride is never priced (USD). */
  minimum_fare: number;
  /** Flat booking fee (USD). */
  booking_fee: number;
  /** Service fee as a fraction of the subtotal (0.10 = 10%). */
  service_fee_rate: number;
  /** Tax as a fraction of the taxable amount (0.0875 = 8.75%). */
  tax_rate: number;
  /** Upper bound for the combined demand × time multiplier. */
  max_demand_multiplier: number;
  /** Time-of-day multiplier at peak demand (>= 1.0). */
  peak_time_multiplier: number;
  /** Time-of-day multiplier off-peak (<= 1.0). */
  off_peak_multiplier: number;
}

/** Fallback used when the DB row is missing/unreachable. */
export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  base_fare: 3.50,
  per_km_rate: 1.50,
  per_minute_rate: 0.35,
  minimum_fare: 7.00,
  booking_fee: 1.50,
  service_fee_rate: 0.10,
  tax_rate: 0.0875,
  max_demand_multiplier: 2.00,
  peak_time_multiplier: 1.25,
  off_peak_multiplier: 0.95,
};

const CONFIG_CACHE_TTL_MS = 60_000;
let cachedConfig: PricingConfig = DEFAULT_PRICING_CONFIG;
let cachedConfigAt = 0;

function normalizeConfig(raw: any): PricingConfig {
  const num = (v: any, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    base_fare: num(raw.base_fare, DEFAULT_PRICING_CONFIG.base_fare),
    per_km_rate: num(raw.per_km_rate, DEFAULT_PRICING_CONFIG.per_km_rate),
    per_minute_rate: num(raw.per_minute_rate, DEFAULT_PRICING_CONFIG.per_minute_rate),
    minimum_fare: num(raw.minimum_fare, DEFAULT_PRICING_CONFIG.minimum_fare),
    booking_fee: num(raw.booking_fee, DEFAULT_PRICING_CONFIG.booking_fee),
    service_fee_rate: num(raw.service_fee_rate, DEFAULT_PRICING_CONFIG.service_fee_rate),
    tax_rate: num(raw.tax_rate, DEFAULT_PRICING_CONFIG.tax_rate),
    max_demand_multiplier: num(raw.max_demand_multiplier, DEFAULT_PRICING_CONFIG.max_demand_multiplier),
    peak_time_multiplier: num(raw.peak_time_multiplier, DEFAULT_PRICING_CONFIG.peak_time_multiplier),
    off_peak_multiplier: num(raw.off_peak_multiplier, DEFAULT_PRICING_CONFIG.off_peak_multiplier),
  };
}

/**
 * Refreshes the in-memory config from the DB. Never throws — falls back to
 * defaults on any failure so the hot path can never be blocked.
 */
export async function getConfig(force = false): Promise<PricingConfig> {
  if (!force && Date.now() - cachedConfigAt < CONFIG_CACHE_TTL_MS) {
    return cachedConfig;
  }
  try {
    const res = await pool.query('SELECT * FROM pricing_configurations WHERE id = 1');
    if (res.rows.length > 0) {
      cachedConfig = normalizeConfig(res.rows[0]);
      cachedConfigAt = Date.now();
    }
  } catch (err: any) {
    console.warn(`[PRICING] ⚠️ Config load failed (using defaults): ${err.message}`);
  }
  return cachedConfig;
}

// ---------------------------------------------------------------------------
// 2. MARKET CONDITIONS  (deterministic — derived from real platform signals)
// ---------------------------------------------------------------------------

export interface MarketConditions {
  /** Active ride requests / online drivers. */
  demandRatio: number;
  onlineDrivers: number;
  activeRequests: number;
  /** Hour of day (UTC 0-23) used for the deterministic demand curve. */
  hourOfDay: number;
  /** Demand-supply multiplier (>= 1 during high demand, < 1 during slack). */
  demandMultiplier: number;
  /** Time-of-day multiplier (peak rush hours raise it, off-peak lowers it). */
  timeMultiplier: number;
  reasons: string[];
  computedAt: number;
}

const DEFAULT_MARKET: MarketConditions = {
  demandRatio: 1.0,
  onlineDrivers: 0,
  activeRequests: 0,
  hourOfDay: new Date().getUTCHours(),
  demandMultiplier: 1.0,
  timeMultiplier: 1.0,
  reasons: ['Default market (not yet refreshed)'],
  computedAt: 0,
};

let currentMarket: MarketConditions = DEFAULT_MARKET;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Computes current market conditions WITHOUT any randomness. Uses:
 *   - the actual demand/supply ratio (active ride requests in the last
 *     30 minutes vs. online drivers)
 *   - a smooth time-of-day demand curve (rush hours raise prices)
 */
export async function computeMarketConditions(now: Date = new Date()): Promise<MarketConditions> {
  const reasons: string[] = [];

  let activeRequests = 0;
  let onlineDrivers = 0;
  try {
    const res = (await pool.query(
      `SELECT COUNT(*)::int AS count FROM rides WHERE created_at > NOW() - INTERVAL '30 minutes'`
    )) as any;
    activeRequests = Number(res.rows?.[0]?.count ?? 0);
  } catch (err: any) {
    console.warn(`[PRICING] ⚠️ Active-request count failed: ${err.message}`);
  }
  try {
    onlineDrivers = await redis.zcard(DRIVER_LOCATIONS_KEY);
  } catch (err: any) {
    console.warn(`[PRICING] ⚠️ Online-driver count failed: ${err.message}`);
  }

  const demandRatio = activeRequests / Math.max(1, onlineDrivers);
  const hourOfDay = now.getUTCHours();

  // Demand-supply multiplier.
  let demandMultiplier = 1.0;
  if (demandRatio >= 1.5) {
    demandMultiplier = 1.5;
    reasons.push(`High demand/supply ratio (${demandRatio.toFixed(2)}) → ×1.50`);
  } else if (demandRatio <= 0.5) {
    demandMultiplier = 0.9;
    reasons.push(`Low demand/supply ratio (${demandRatio.toFixed(2)}) → ×0.90`);
  } else {
    reasons.push(`Balanced demand/supply ratio (${demandRatio.toFixed(2)}) → ×1.00`);
  }

  // Smooth time-of-day curve (0..1). Peaks at ~8h and ~18h.
  const morning = Math.exp(-Math.pow(hourOfDay - 8, 2) / 8);
  const evening = Math.exp(-Math.pow(hourOfDay - 18, 2) / 8);
  const timeDemand = Math.min(1, morning + evening);

  // Apply the configured bounds (defaults: peak ×1.25, off-peak ×0.95).
  const config = cachedConfig;
  const timeMultiplier = round2(clamp(
    1 + (timeDemand - 0.4) * 1.0,
    config.off_peak_multiplier,
    config.peak_time_multiplier,
  ));
  if (timeMultiplier > 1.01) {
    reasons.push(`Peak time-of-day demand → ×${timeMultiplier.toFixed(2)}`);
  } else if (timeMultiplier < 0.99) {
    reasons.push(`Off-peak time-of-day → ×${timeMultiplier.toFixed(2)}`);
  } else {
    reasons.push('Neutral time-of-day → ×1.00');
  }

  return {
    demandRatio,
    onlineDrivers,
    activeRequests,
    hourOfDay,
    demandMultiplier: round2(demandMultiplier),
    timeMultiplier,
    reasons,
    computedAt: Date.now(),
  };
}

/** Returns the latest in-memory market (never null; defaults until refreshed). */
export function getMarket(): MarketConditions {
  return currentMarket;
}

/**
 * Recomputes and caches the market conditions, and writes them to Redis for
 * observability/admin. Called on a 5-minute interval + once at boot.
 */
export async function refreshMarketConditions(): Promise<MarketConditions> {
  try {
    await getConfig(true);
  } catch { /* config refresh is best-effort */ }
  const market = await computeMarketConditions();
  currentMarket = market;
  try {
    await redis.set(
      'pricing:system_conditions',
      JSON.stringify({ ...market }),
      'EX',
      900,
    );
  } catch (err: any) {
    console.warn(`[PRICING] ⚠️ Redis condition publish failed: ${err.message}`);
  }
  console.log(
    `[PRICING] 🌍 Market refreshed: demandRatio=${market.demandRatio.toFixed(2)} ` +
    `(×${market.demandMultiplier.toFixed(2)}), time=×${market.timeMultiplier.toFixed(2)} ` +
    `(${market.reasons.join('; ')})`,
  );
  return market;
}

// ---------------------------------------------------------------------------
// 3. FARE COMPUTATION  (pure, in-memory, microseconds)
// ---------------------------------------------------------------------------

export interface FareInput {
  /** Trip distance in meters. */
  distanceMeters: number;
  /** Expected trip duration in seconds (for the time component). */
  durationSeconds: number;
}

export interface MultiplierBreakdown {
  demandMultiplier: number;
  timeMultiplier: number;
  totalMultiplier: number;
  reasons: string[];
}

export interface FareBreakdown {
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  bookingFee: number;
  /** Combined demand × time multiplier (surge). */
  surgeMultiplier: number;
  serviceFee: number;
  taxes: number;
  totalFare: number;
  currency: 'USD';
  multiplierBreakdown: MultiplierBreakdown;
}

/**
 * Pure, deterministic fare computation. No I/O — safe to call from the
 * routing hot path. `market` and `config` are supplied by the caller
 * (typically the cached in-memory values).
 */
export function computeFare(
  input: FareInput,
  config: PricingConfig = cachedConfig,
  market: MarketConditions = currentMarket,
): FareBreakdown {
  const distanceKm = input.distanceMeters / 1000;
  const durationMinutes = input.durationSeconds / 60;

  const totalMultiplier = clamp(
    market.demandMultiplier * market.timeMultiplier,
    0.85,
    config.max_demand_multiplier,
  );

  const baseFare = config.base_fare;
  const distanceFare = distanceKm * config.per_km_rate;
  const timeFare = durationMinutes * config.per_minute_rate;
  const bookingFee = config.booking_fee;

  const rideSubtotal = (baseFare + distanceFare + timeFare) * totalMultiplier;
  const subtotal = rideSubtotal + bookingFee;
  const serviceFee = subtotal * config.service_fee_rate;
  const taxable = subtotal + serviceFee;
  const taxes = taxable * config.tax_rate;
  const totalFare = Math.max(config.minimum_fare, round2(taxable + taxes));

  return {
    baseFare: round2(baseFare),
    distanceFare: round2(distanceFare),
    timeFare: round2(timeFare),
    bookingFee: round2(bookingFee),
    surgeMultiplier: round2(totalMultiplier),
    serviceFee: round2(serviceFee),
    taxes: round2(taxes),
    totalFare,
    currency: 'USD',
    multiplierBreakdown: {
      demandMultiplier: market.demandMultiplier,
      timeMultiplier: market.timeMultiplier,
      totalMultiplier: round2(totalMultiplier),
      reasons: market.reasons,
    },
  };
}

/**
 * Estimate entry point for the routing hot path — synchronous, in-memory,
 * never touches the DB/Redis.
 */
export function computeEstimate(input: FareInput): FareBreakdown {
  return computeFare(input, cachedConfig, currentMarket);
}

// ---------------------------------------------------------------------------
// 4. PRICE SNAPSHOTS  (quoted fare == charged fare)
// ---------------------------------------------------------------------------

export interface PriceSnapshot {
  ride_id: string;
  distance_km: number;
  duration_minutes: number;
  multiplier_breakdown: MultiplierBreakdown;
  config: PricingConfig;
  final_fare: number;
  created_at: Date;
}

/**
 * Computes a fare with a fresh config and persists it as the ride's price
 * snapshot. Returns the breakdown so callers can store/emit the total.
 */
export async function createPriceSnapshot(
  rideId: string,
  input: FareInput,
): Promise<FareBreakdown> {
  const config = await getConfig(true);
  const breakdown = computeFare(input, config, currentMarket);

  const distanceKm = round2(input.distanceMeters / 1000);
  const durationMinutes = round2(input.durationSeconds / 60);

  try {
    await pool.query(
      `INSERT INTO ride_price_snapshots
         (ride_id, distance_km, duration_minutes, multiplier_breakdown, config, final_fare)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
       ON CONFLICT (ride_id) DO UPDATE SET
         distance_km = EXCLUDED.distance_km,
         duration_minutes = EXCLUDED.duration_minutes,
         multiplier_breakdown = EXCLUDED.multiplier_breakdown,
         config = EXCLUDED.config,
         final_fare = EXCLUDED.final_fare,
         created_at = NOW()`,
      [
        rideId,
        distanceKm,
        durationMinutes,
        JSON.stringify(breakdown.multiplierBreakdown),
        JSON.stringify(config),
        breakdown.totalFare,
      ],
    );
  } catch (err: any) {
    console.error(`[PRICING] ❌ Snapshot persist failed for ride ${rideId}: ${err.message}`);
  }

  return breakdown;
}

/** Reads a ride's price snapshot, or null when none exists. */
export async function getSnapshotForRide(rideId: string): Promise<PriceSnapshot | null> {
  try {
    const res = await pool.query(
      `SELECT ride_id, distance_km, duration_minutes, multiplier_breakdown, config, final_fare, created_at
       FROM ride_price_snapshots WHERE ride_id = $1`,
      [rideId],
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      ride_id: r.ride_id,
      distance_km: Number(r.distance_km),
      duration_minutes: Number(r.duration_minutes),
      multiplier_breakdown: r.multiplier_breakdown,
      config: normalizeConfig(r.config ?? {}),
      final_fare: Number(r.final_fare),
      created_at: r.created_at,
    };
  } catch (err: any) {
    console.warn(`[PRICING] ⚠️ Snapshot read failed for ride ${rideId}: ${err.message}`);
    return null;
  }
}

/**
 * Resolves the fare that should be shown to a driver for a ride: the
 * persisted snapshot when present, otherwise a live estimate. Used by the
 * dispatch jobs so every driver sees the same platform price.
 */
export async function resolveRideFare(rideId: string, input: FareInput): Promise<number> {
  const snapshot = await getSnapshotForRide(rideId);
  if (snapshot) return snapshot.final_fare;
  return computeEstimate(input).totalFare;
}

export const pricingService = {
  DEFAULT_PRICING_CONFIG,
  getConfig,
  getMarket,
  refreshMarketConditions,
  computeFare,
  computeEstimate,
  createPriceSnapshot,
  getSnapshotForRide,
  resolveRideFare,
};
