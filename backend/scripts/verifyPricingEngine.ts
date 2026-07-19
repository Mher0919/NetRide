// backend/scripts/verifyPricingEngine.ts
//
// Standalone verification of the centralized pricing engine.
// Run: npx ts-node backend/scripts/verifyPricingEngine.ts
//
// Covers the required validation loop checks that do NOT need a live DB:
//  - Determinism: same inputs -> same output (no RNG / randomness)
//  - Personalization: drivers with different performance get different ranges
//  - Cooldown math: server-time derived, persists across "restarts"
//  - Bounds & increments

import {
  computeDriverRange,
  getCooldownState,
  isPriceChangeAllowed,
  resolveCurrentPrice,
  PRICE_COOLDOWN_MS,
  ABSOLUTE_MIN_PRICE,
} from '../src/services/pricingEngine';
import type { PricingInputs, MarketConditions } from '../src/services/pricingEngine';

let failures = 0;
function assert(name: string, cond: boolean, extra = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

const market: MarketConditions = {
  xShift: 0.25,
  demandRatio: 1.0,
  onlineDrivers: 10,
  activeRequests: 10,
  hourOfDay: 12,
  reasons: ['test market'],
};

const topDriver: PricingInputs = {
  user_id: 'd1',
  active_class: 'CORE',
  rating: 4.9,
  total_rides: 1200,
  acceptance_count: 300,
  cancellation_count: 2,
  is_dangerous: false,
  is_flagged: false,
  last_cancellation_at: null,
};

const badDriver: PricingInputs = {
  user_id: 'd2',
  active_class: 'CORE',
  rating: 3.9,
  total_rides: 5,
  acceptance_count: 10,
  cancellation_count: 25,
  is_dangerous: true,
  is_flagged: true,
  last_cancellation_at: new Date(),
};

console.log('\n[1] Determinism — same inputs yield identical output');
const r1 = computeDriverRange(topDriver, market);
const r2 = computeDriverRange(topDriver, market);
assert('identical min', r1.price_range_min === r2.price_range_min);
assert('identical max', r1.price_range_max === r2.price_range_max);
assert('identical recommended', r1.recommended_price === r2.recommended_price);
assert('explanation present', r1.explanation.length > 0);

console.log('\n[2] Personalization — different performance -> different range');
const bad = computeDriverRange(badDriver, market);
console.log(`    topDriver range: ${r1.price_range_min}..${r1.price_range_max}`);
console.log(`    badDriver range: ${bad.price_range_min}..${bad.price_range_max}`);
assert('ranges differ', r1.price_range_max !== bad.price_range_max || r1.price_range_min !== bad.price_range_min);
assert('bad driver capped lower max', bad.price_range_max < r1.price_range_max);
assert('bad driver at/above floor', bad.price_range_min >= ABSOLUTE_MIN_PRICE);

console.log('\n[3] Bounds & increments');
assert('min >= floor', r1.price_range_min >= ABSOLUTE_MIN_PRICE);
assert('max - min >= 2.00', r1.price_range_max - r1.price_range_min >= 2.0);
assert('min is quarter multiple', Math.abs(r1.price_range_min * 4 - Math.round(r1.price_range_min * 4)) < 1e-9);
assert('max is quarter multiple', Math.abs(r1.price_range_max * 4 - Math.round(r1.price_range_max * 4)) < 1e-9);
assert('recommended within range', r1.recommended_price >= r1.price_range_min && r1.recommended_price <= r1.price_range_max);

console.log('\n[4] resolveCurrentPrice clamps into range');
assert('clamps above', resolveCurrentPrice(999, r1) === r1.price_range_max);
assert('clamps below', resolveCurrentPrice(0, r1) === r1.price_range_min);
assert('null -> midpoint', resolveCurrentPrice(null, r1) >= r1.price_range_min && resolveCurrentPrice(null, r1) <= r1.price_range_max);

console.log('\n[5] Cooldown — server-time derived, survives "restart"');
// Simulate a price change "now": persistence is just the timestamp.
const changedAt = Date.now();
let cd = getCooldownState(new Date(changedAt));
assert('active immediately after change', cd.cooldownActive === true);
assert('remaining ~= cooldown', Math.abs(cd.remainingMs - PRICE_COOLDOWN_MS) < 2000);
assert('not allowed immediately', isPriceChangeAllowed(new Date(changedAt)) === false);

// Simulate app closed for 2 hours: we recompute from the SAME persisted timestamp.
const twoHoursLater = changedAt + 2 * 60 * 60 * 1000;
const cd2 = getCooldownState(new Date(changedAt), twoHoursLater);
assert('still active at 2h', cd2.cooldownActive === true);
assert('remaining ~= 2h left', Math.abs(cd2.remainingMs - 2 * 60 * 60 * 1000) < 2000, `got ${cd2.remainingMs}`);
assert('NOT reset by "restart"', cd2.remainingMs < PRICE_COOLDOWN_MS);

// Simulate app closed past 4 hours.
const fiveHoursLater = changedAt + 5 * 60 * 60 * 1000;
const cd3 = getCooldownState(new Date(changedAt), fiveHoursLater);
assert('expired after 4h', cd3.cooldownActive === false);
assert('allowed after 4h', isPriceChangeAllowed(new Date(changedAt), fiveHoursLater) === true);
assert('remaining 0 after expiry', cd3.remainingMs === 0);

console.log('\n[6] Null last-changed => no cooldown');
assert('null => allowed', isPriceChangeAllowed(null) === true);

console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
