// backend/src/services/pricing.service.ts
//
// CENTRAL PRICING ENGINE — SINGLE SOURCE OF TRUTH FOR ALL RIDE PRICING
// --------------------------------------------------------------------
// Every client (rider app, driver app, admin, dispatch) consumes the values
// produced here. No other module may compute a fare. Driver-controlled
// pricing has been removed — the platform owns pricing end to end.
//
// Design goals:
//  - Profile-driven:  every rate lives in a named `pricing_profiles` row
//                     (code = ride category, currently only PREMIUM).
//                     Profiles are configuration, never code — adding a new
//                     ride category (STANDARD / BLACK / XL / LUXURY) is an
//                     INSERT plus a label; the engine does not change.
//  - Deterministic:   identical inputs always yield identical outputs.
//  - Explainable:     every multiplier carries a human-readable reason.
//  - Fast:            the routing hot path never touches the DB or Redis —
//                     config + market conditions are cached in memory and
//                     refreshed by a periodic job.
//  - Independent:     fares are derived solely from NetRide's own profiles.
//                     No competitor pricing is consulted anywhere.
//  - Snapshot-able:   every ride persists a price snapshot (distance, ETA,
//                     multiplier breakdown, profile, final fare) so the fare
//                     quoted at request time is the fare charged at accept
//                     time — booking, payout, and payment all agree.
//
// Production fare model (041): flat fare —
//   rawFare    = base_fare + miles × per_mile_rate + minutes × per_minute_rate
//   finalFare  = max(minimum_fare, round(rawFare))
// Booking fee, service fee, and tax are zeroed and multipliers pinned to 1.00
// in the live PREMIUM profile, so the engine output is deterministic-flat.
//
// Revenue model (041): 60% driver / 40% platform (revenue_configs singleton).
// The platform pool is split between the ride's fleet partner (configured
// share of the pool) and NetRide (remainder). The per-ride allocation is
// persisted on the price snapshot so every ride reconciles exactly:
//   finalFare = driverShare + fleetShare + netrideShare (cent-exact).

import { pool } from '../config/database';
import { redis, DRIVER_LOCATIONS_KEY } from '../config/redis';

// ---------------------------------------------------------------------------
// 1. PRICING PROFILES
// ---------------------------------------------------------------------------

export interface PricingConfig {
  /** Stable ride-category code (e.g. 'PREMIUM'). */
  code: string;
  /** UI-facing category label (e.g. 'NetRide Premium'). */
  label: string;
  /** Flat fare per ride (USD). */
  base_fare: number;
  /** Rate per mile (USD). */
  per_mile_rate: number;
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
  /** Profile-level weather multiplier (1.0 = weather has no effect). */
  weather_multiplier: number;
  /** Profile-level pickup-area multiplier (1.0 = uniform pricing). */
  location_multiplier: number;
  /** Profile-level fleet multiplier (1.0 = standard fleet). */
  fleet_multiplier: number;
}

/**
 * Fallback profile used when the DB row is missing/unreachable. This is the
 * live PREMIUM profile — the only ride category currently exposed. Values
 * match the production flat-fare spec (041).
 */
export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  code: 'PREMIUM',
  label: 'NetRide Premium',
  base_fare: 4.00,
  per_mile_rate: 2.50,
  per_minute_rate: 0.40,
  minimum_fare: 10.00,
  booking_fee: 0.00,
  service_fee_rate: 0.00,
  tax_rate: 0.00,
  max_demand_multiplier: 1.00,
  peak_time_multiplier: 1.00,
  off_peak_multiplier: 1.00,
  weather_multiplier: 1.00,
  location_multiplier: 1.00,
  fleet_multiplier: 1.00,
};

const CONFIG_CACHE_TTL_MS = 60_000;
const cachedConfigs = new Map<string, { config: PricingConfig; at: number }>();

function normalizeConfig(raw: any): PricingConfig {
  const num = (v: any, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    code: (raw.code ?? DEFAULT_PRICING_CONFIG.code).toString().toUpperCase(),
    label: (raw.label ?? DEFAULT_PRICING_CONFIG.label).toString(),
    base_fare: num(raw.base_fare, DEFAULT_PRICING_CONFIG.base_fare),
    per_mile_rate: num(raw.per_mile_rate, DEFAULT_PRICING_CONFIG.per_mile_rate),
    per_minute_rate: num(raw.per_minute_rate, DEFAULT_PRICING_CONFIG.per_minute_rate),
    minimum_fare: num(raw.minimum_fare, DEFAULT_PRICING_CONFIG.minimum_fare),
    booking_fee: num(raw.booking_fee, DEFAULT_PRICING_CONFIG.booking_fee),
    service_fee_rate: num(raw.service_fee_rate, DEFAULT_PRICING_CONFIG.service_fee_rate),
    tax_rate: num(raw.tax_rate, DEFAULT_PRICING_CONFIG.tax_rate),
    max_demand_multiplier: num(raw.max_demand_multiplier, DEFAULT_PRICING_CONFIG.max_demand_multiplier),
    peak_time_multiplier: num(raw.peak_time_multiplier, DEFAULT_PRICING_CONFIG.peak_time_multiplier),
    off_peak_multiplier: num(raw.off_peak_multiplier, DEFAULT_PRICING_CONFIG.off_peak_multiplier),
    weather_multiplier: num(raw.weather_multiplier, DEFAULT_PRICING_CONFIG.weather_multiplier),
    location_multiplier: num(raw.location_multiplier, DEFAULT_PRICING_CONFIG.location_multiplier),
    fleet_multiplier: num(raw.fleet_multiplier, DEFAULT_PRICING_CONFIG.fleet_multiplier),
  };
}

/**
 * Refreshes the in-memory profile from the DB. Never throws — falls back to
 * defaults on any failure so the hot path can never be blocked.
 *
 * @param profileCode ride-category code (defaults to the live PREMIUM profile)
 * @param force       bypass the 60s in-memory cache
 */
export async function getConfig(profileCode = 'PREMIUM', force = false): Promise<PricingConfig> {
  const key = profileCode.toUpperCase();
  const entry = cachedConfigs.get(key);
  if (!force && entry && Date.now() - entry.at < CONFIG_CACHE_TTL_MS) {
    return entry.config;
  }
  try {
    const res = await pool.query(
      'SELECT * FROM pricing_profiles WHERE code = $1 AND active = TRUE',
      [key],
    );
    if (res.rows.length > 0) {
      cachedConfigs.set(key, { config: normalizeConfig(res.rows[0]), at: Date.now() });
    }
  } catch (err: any) {
    console.warn(`[PRICING] ⚠️ Profile load failed for ${key} (using defaults): ${err.message}`);
  }
  const fallback = cachedConfigs.get(key);
  if (fallback) return fallback.config;
  return { ...DEFAULT_PRICING_CONFIG, code: key };
}

/**
 * Lists every active profile — used by admin surfaces. The engine stays
 * profile-agnostic; adding a ride category never touches pricing logic.
 */
export async function getProfiles(): Promise<PricingConfig[]> {
  try {
    const res = await pool.query(
      'SELECT * FROM pricing_profiles WHERE active = TRUE ORDER BY code',
    );
    return res.rows.map(normalizeConfig);
  } catch (err: any) {
    console.warn(`[PRICING] ⚠️ Profile listing failed: ${err.message}`);
    return [{ ...DEFAULT_PRICING_CONFIG }];
  }
}

/**
 * The currently cached live profile (PREMIUM) — used by the synchronous hot
 * path (estimates) and the market refresher. Never throws.
 */
function currentConfig(): PricingConfig {
  return cachedConfigs.get('PREMIUM')?.config ?? DEFAULT_PRICING_CONFIG;
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
  const config = currentConfig();
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
    await getConfig('PREMIUM', true);
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
  fleetMultiplier: number;
  weatherMultiplier: number;
  locationMultiplier: number;
  totalMultiplier: number;
  reasons: string[];
}

export interface FareBreakdown {
  /** Trip distance in miles (production spec). */
  distanceMiles: number;
  /** Trip duration in minutes (production spec). */
  durationMinutes: number;
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  bookingFee: number;
  /** Combined demand × time × fleet × weather × location multiplier. */
  surgeMultiplier: number;
  serviceFee: number;
  taxes: number;
  totalFare: number;
  currency: 'USD';
  multiplierBreakdown: MultiplierBreakdown;
}

/** Meters per mile (US statute). */
const METERS_PER_MILE = 1609.344;

/**
 * Pure, deterministic fare computation. No I/O — safe to call from the
 * routing hot path. `market` and `config` are supplied by the caller
 * (typically the cached in-memory values).
 */
export function computeFare(
  input: FareInput,
  config: PricingConfig = currentConfig(),
  market: MarketConditions = currentMarket,
): FareBreakdown {
  const distanceMiles = input.distanceMeters / METERS_PER_MILE;
  const durationMinutes = input.durationSeconds / 60;

  // Multiplier pipeline. Demand × time come from live market conditions;
  // fleet, weather, and location come from the profile configuration. Every
  // factor is non-negative and clamped to the profile's surge ceiling. The
  // live PREMIUM profile pins every multiplier to 1.00, so the production
  // fare is deterministic-flat; raising the caps in config re-enables surge.
  const demandTime = clamp(
    market.demandMultiplier * market.timeMultiplier,
    0.85,
    config.max_demand_multiplier,
  );
  const fleetMultiplier = clamp(Math.max(0, config.fleet_multiplier), 0.85, config.max_demand_multiplier);
  const weatherMultiplier = clamp(Math.max(0, config.weather_multiplier), 0.85, config.max_demand_multiplier);
  const locationMultiplier = clamp(Math.max(0, config.location_multiplier), 0.85, config.max_demand_multiplier);
  const totalMultiplier = round2(demandTime * fleetMultiplier * weatherMultiplier * locationMultiplier);

  const reasons = [...market.reasons];
  if (fleetMultiplier !== 1) {
    reasons.push(`Fleet multiplier (${config.label}) → ×${fleetMultiplier.toFixed(2)}`);
  }
  if (weatherMultiplier !== 1) {
    reasons.push(`Weather multiplier (${config.label}) → ×${weatherMultiplier.toFixed(2)}`);
  }
  if (locationMultiplier !== 1) {
    reasons.push(`Pickup-area multiplier (${config.label}) → ×${locationMultiplier.toFixed(2)}`);
  }

  const baseFare = config.base_fare;
  const distanceFare = distanceMiles * config.per_mile_rate;
  const timeFare = durationMinutes * config.per_minute_rate;
  const bookingFee = config.booking_fee;

  const rideSubtotal = (baseFare + distanceFare + timeFare) * totalMultiplier;
  const subtotal = rideSubtotal + bookingFee;
  const serviceFee = subtotal * config.service_fee_rate;
  const taxable = subtotal + serviceFee;
  const taxes = taxable * config.tax_rate;
  const totalFare = Math.max(config.minimum_fare, round2(taxable + taxes));

  return {
    distanceMiles: round2(distanceMiles),
    durationMinutes: round2(durationMinutes),
    baseFare: round2(baseFare),
    distanceFare: round2(distanceFare),
    timeFare: round2(timeFare),
    bookingFee: round2(bookingFee),
    surgeMultiplier: totalMultiplier,
    serviceFee: round2(serviceFee),
    taxes: round2(taxes),
    totalFare,
    currency: 'USD',
    multiplierBreakdown: {
      demandMultiplier: market.demandMultiplier,
      timeMultiplier: market.timeMultiplier,
      fleetMultiplier: round2(fleetMultiplier),
      weatherMultiplier: round2(weatherMultiplier),
      locationMultiplier: round2(locationMultiplier),
      totalMultiplier,
      reasons,
    },
  };
}

/**
 * Estimate entry point for the routing hot path — synchronous, in-memory,
 * never touches the DB/Redis. Always prices the live PREMIUM profile.
 */
export function computeEstimate(input: FareInput): FareBreakdown {
  return computeFare(input, currentConfig(), currentMarket);
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
 *
 * `client` (optional) runs the persist inside the caller's transaction so
 * the snapshot commits atomically with the ride row + rewards.
 */
export async function createPriceSnapshot(
  rideId: string,
  input: FareInput,
  client?: any,
): Promise<FareBreakdown> {
  const config = await getConfig('PREMIUM', true);
  const breakdown = computeFare(input, config, currentMarket);

  const distanceKm = round2(input.distanceMeters / 1000);
  const durationMinutes = round2(input.durationSeconds / 60);

  try {
    const db = client ?? pool;
    await db.query(
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

// ---------------------------------------------------------------------------
// 5. REVENUE ALLOCATION  (60/40 driver/platform + dynamic fleet shares)
// ---------------------------------------------------------------------------
// Single source of truth for the money split. Every completed ride records
// its allocation on the price snapshot, and the invariant always holds:
//   finalFare = driverShare + ΣfleetShares + netrideShare  (cent-exact)
//
// Global split (revenue_configs, id=1): driver 60% / platform 40%.
// Platform pool: the ride's fleet partner (assigned + active) receives its
// configured share of the pool; NetRide keeps the remainder. A driver
// without a fleet leaves the entire platform pool to NetRide.

export interface RevenueConfig {
  driverSharePercent: number;
  platformSharePercent: number;
}

export interface FleetShare {
  fleetId: string;
  name: string;
  cents: number;
}

export interface RevenueAllocation {
  driverShareCents: number;
  platformShareCents: number;
  fleetShares: FleetShare[];
  netrideShareCents: number;
  driverSharePercent: number;
  platformSharePercent: number;
  /** fleetId → cents (mirrors fleetShares for lookup). */
  fleetAllocationMap: Record<string, number>;
}

export interface FleetPartnerRow {
  id: string;
  name: string;
  platformSharePercent: number;
  isActive: boolean;
}

export const DEFAULT_REVENUE_CONFIG: RevenueConfig = {
  driverSharePercent: 60,
  platformSharePercent: 40,
};

const REVENUE_CACHE_TTL_MS = 60_000;
let cachedRevenueConfig: { config: RevenueConfig; at: number } | null = null;
let cachedFleets: { fleets: FleetPartnerRow[]; at: number } | null = null;

/** Global split from revenue_configs (60/40 fallback, never throws). */
export async function getRevenueConfig(force = false): Promise<RevenueConfig> {
  if (!force && cachedRevenueConfig && Date.now() - cachedRevenueConfig.at < REVENUE_CACHE_TTL_MS) {
    return cachedRevenueConfig.config;
  }
  try {
    const res = await pool.query(
      `SELECT driver_share_percent, platform_share_percent
       FROM revenue_configs WHERE id = 1`,
    );
    const row = res.rows[0];
    if (row) {
      const candidate = {
        driverSharePercent: Number(row.driver_share_percent),
        platformSharePercent: Number(row.platform_share_percent),
      };
      // DB CHECK guarantees the sum; validate defensively anyway.
      if (Math.abs(candidate.driverSharePercent + candidate.platformSharePercent - 100) < 0.01) {
        cachedRevenueConfig = { config: candidate, at: Date.now() };
      }
    }
  } catch (err: any) {
    console.warn(`[PRICING] ⚠️ Revenue config load failed (using 60/40): ${err.message}`);
  }
  if (cachedRevenueConfig) return cachedRevenueConfig.config;
  return { ...DEFAULT_REVENUE_CONFIG };
}

/** Active fleet partners (empty fallback, never throws). */
export async function getFleetPartners(force = false): Promise<FleetPartnerRow[]> {
  if (!force && cachedFleets && Date.now() - cachedFleets.at < REVENUE_CACHE_TTL_MS) {
    return cachedFleets.fleets;
  }
  try {
    const res = await pool.query(
      `SELECT id, name, platform_share_percent, is_active
       FROM fleet_partners WHERE is_active = TRUE ORDER BY name`,
    );
    cachedFleets = {
      fleets: res.rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        platformSharePercent: Number(r.platform_share_percent),
        isActive: r.is_active === true,
      })),
      at: Date.now(),
    };
  } catch (err: any) {
    console.warn(`[PRICING] ⚠️ Fleet partner load failed: ${err.message}`);
  }
  if (cachedFleets) return cachedFleets.fleets;
  return [];
}

/** Drop the revenue caches after an admin edit so the next call re-reads. */
export function invalidateRevenueCache(): void {
  cachedRevenueConfig = null;
  cachedFleets = null;
}

/**
 * Pure, deterministic revenue split. No I/O. Cent-exact by construction:
 * driverShare + Σfleet + netride === fareCents.
 *
 * @param fareCents      gross fare in whole cents (>= 0)
 * @param driverFleetId  the ride driver's fleet assignment (null = platform-direct)
 * @param revenueConfig  global split (falls back to 60/40 if invalid)
 * @param fleets         active fleet partners
 */
export function computeRevenueSplit(
  fareCents: number,
  driverFleetId: string | null,
  revenueConfig: RevenueConfig = DEFAULT_REVENUE_CONFIG,
  fleets: FleetPartnerRow[] = [],
): RevenueAllocation {
  const fare = Math.max(0, Math.round(fareCents));
  const cfg =
    Math.abs(revenueConfig.driverSharePercent + revenueConfig.platformSharePercent - 100) < 0.01
      ? revenueConfig
      : DEFAULT_REVENUE_CONFIG;

  const driverShareCents = Math.round((fare * cfg.driverSharePercent) / 100);
  const platformShareCents = fare - driverShareCents;

  const fleet = driverFleetId
    ? fleets.find((f) => f.id === driverFleetId && f.isActive && f.platformSharePercent > 0)
    : undefined;

  let fleetShares: FleetShare[] = [];
  let netrideShareCents = platformShareCents;
  if (fleet) {
    const fleetCents = Math.round((platformShareCents * fleet.platformSharePercent) / 100);
    fleetShares = [{ fleetId: fleet.id, name: fleet.name, cents: fleetCents }];
    netrideShareCents = platformShareCents - fleetCents;
  }

  const fleetAllocationMap: Record<string, number> = {};
  for (const fs of fleetShares) fleetAllocationMap[fs.fleetId] = fs.cents;

  return {
    driverShareCents,
    platformShareCents,
    fleetShares,
    netrideShareCents,
    driverSharePercent: cfg.driverSharePercent,
    platformSharePercent: cfg.platformSharePercent,
    fleetAllocationMap,
  };
}

/** Live allocation for a fare + driver fleet (cached config, no DB on caller). */
export async function computeRevenueAllocation(
  fareCents: number,
  driverFleetId: string | null,
): Promise<RevenueAllocation> {
  const [config, fleets] = await Promise.all([getRevenueConfig(), getFleetPartners()]);
  return computeRevenueSplit(fareCents, driverFleetId, config, fleets);
}

/**
 * Computes the allocation for a ride and persists it on the price snapshot.
 * `client` (optional) runs the write inside the caller's transaction.
 * Never throws — returns the allocation, or null when persistence failed.
 */
export async function persistRevenueAllocation(
  rideId: string,
  driverId: string | null,
  fareCents: number,
  client?: any,
): Promise<RevenueAllocation | null> {
  try {
    let fleetId: string | null = null;
    if (driverId) {
      const res = await pool.query('SELECT fleet_id FROM drivers WHERE user_id = $1', [driverId]);
      fleetId = res.rows[0]?.fleet_id ?? null;
    }
    const [config, fleets] = await Promise.all([getRevenueConfig(), getFleetPartners()]);
    const allocation = computeRevenueSplit(fareCents, fleetId, config, fleets);

    const db = client ?? pool;
    await db.query(
      `UPDATE ride_price_snapshots SET
         driver_share_cents      = $2,
         platform_share_cents    = $3,
         netride_share_cents     = $4,
         fleet_allocations       = $5::jsonb,
         driver_fleet_id         = $6,
         revenue_config_snapshot = $7::jsonb
       WHERE ride_id = $1`,
      [
        rideId,
        allocation.driverShareCents,
        allocation.platformShareCents,
        allocation.netrideShareCents,
        JSON.stringify(allocation.fleetShares),
        fleetId,
        JSON.stringify({
          driverSharePercent: config.driverSharePercent,
          platformSharePercent: config.platformSharePercent,
        }),
      ],
    );
    return allocation;
  } catch (err: any) {
    console.error(`[PRICING] ❌ Revenue allocation persist failed for ride ${rideId}: ${err.message}`);
    return null;
  }
}

/** Reads a ride's persisted revenue allocation, or null when absent. */
export async function getRevenueAllocationForRide(rideId: string): Promise<RevenueAllocation | null> {
  try {
    const res = await pool.query(
      `SELECT driver_share_cents, platform_share_cents, netride_share_cents,
              fleet_allocations, revenue_config_snapshot
       FROM ride_price_snapshots WHERE ride_id = $1`,
      [rideId],
    );
    const r = res.rows[0];
    if (!r || r.driver_share_cents == null) return null;

    const fleetShares: FleetShare[] = Array.isArray(r.fleet_allocations) ? r.fleet_allocations : [];
    const fleetAllocationMap: Record<string, number> = {};
    for (const fs of fleetShares) fleetAllocationMap[fs.fleetId] = fs.cents;
    const cfgSnap = r.revenue_config_snapshot ?? {};

    return {
      driverShareCents: Number(r.driver_share_cents),
      platformShareCents: Number(r.platform_share_cents),
      netrideShareCents: Number(r.netride_share_cents),
      fleetShares,
      fleetAllocationMap,
      driverSharePercent: Number(cfgSnap.driverSharePercent ?? DEFAULT_REVENUE_CONFIG.driverSharePercent),
      platformSharePercent: Number(cfgSnap.platformSharePercent ?? DEFAULT_REVENUE_CONFIG.platformSharePercent),
    };
  } catch (err: any) {
    console.warn(`[PRICING] ⚠️ Revenue allocation read failed for ride ${rideId}: ${err.message}`);
    return null;
  }
}

/** Admin financial visibility: global + per-fleet aggregates (cents). */
export async function getRevenueSummary(): Promise<any> {
  const globalRes = await pool.query(
    `SELECT
       COALESCE(SUM(final_fare * 100), 0)::bigint AS total_fare_cents,
       COALESCE(SUM(driver_share_cents), 0)::bigint AS total_driver_share_cents,
       COALESCE(SUM(platform_share_cents), 0)::bigint AS total_platform_share_cents,
       COALESCE(SUM(netride_share_cents), 0)::bigint AS total_netride_share_cents,
       COUNT(*)::int AS rides_with_allocation
     FROM ride_price_snapshots
     WHERE driver_share_cents IS NOT NULL`,
  );
  const fleetRes = await pool.query(
    `SELECT s.driver_fleet_id AS fleet_id,
            COALESCE(f.name, 'Unknown') AS fleet_name,
            COUNT(*)::int AS rides,
            COALESCE(SUM((s.fleet_allocations->0->>'cents')::bigint), 0)::bigint AS fleet_earnings_cents
     FROM ride_price_snapshots s
     LEFT JOIN fleet_partners f ON f.id = s.driver_fleet_id
     WHERE s.driver_fleet_id IS NOT NULL
     GROUP BY s.driver_fleet_id, f.name
     ORDER BY fleet_earnings_cents DESC`,
  );
  return { global: globalRes.rows[0] ?? null, per_fleet: fleetRes.rows };
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
  getRevenueConfig,
  getFleetPartners,
  invalidateRevenueCache,
  computeRevenueSplit,
  computeRevenueAllocation,
  persistRevenueAllocation,
  getRevenueAllocationForRide,
  getRevenueSummary,
};
