import { Pool } from 'pg';
import dotenv from 'dotenv';
import {
  pricingService,
  computeEstimate,
  computeMarketConditions,
} from '../../src/services/pricing.service';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  // 1. Config from the seeded PREMIUM pricing profile row.
  const config = await pricingService.getConfig('PREMIUM', true);
  check('getConfig loads seeded PREMIUM profile from DB', config.code === 'PREMIUM' && config.base_fare === 3.5 && config.per_km_rate === 1.5 && config.booking_fee === 1.5 && config.tax_rate === 0.0875, `code=${config.code} base=${config.base_fare}`);

  // 2. Market conditions from Redis + DB counters.
  const market = await computeMarketConditions();
  check('computeMarketConditions reads Redis presence', market.demandRatio >= 0, `demandRatio=${market.demandRatio.toFixed(3)} hour=${market.hourOfDay} timeMul=${market.timeMultiplier}`);

  // 3. refreshMarketConditions persists to Redis.
  await pricingService.refreshMarketConditions();
  const market2 = pricingService.getMarket();
  check('refreshMarketConditions + getMarket in-memory', market2.demandRatio >= 0);

  // 4. Pure estimate on the live market.
  const input = { distanceMeters: 5000, durationSeconds: 600 };
  const est = computeEstimate(input);
  check('computeEstimate deterministic', est.totalFare > 0, `total=${est.totalFare}`);
  const est2 = computeEstimate(input);
  check('computeEstimate stable across calls', est.totalFare === est2.totalFare);

  // 5. Snapshot round-trip against a real ride row.
  const ride = await pool.query(
    `SELECT id, distance_meters, duration_seconds FROM rides ORDER BY created_at DESC LIMIT 1`
  );

  let tempRideId: string | null = null;
  let rideId: string;
  let snapInput: { distanceMeters: number; durationSeconds: number };

  if (ride.rows.length === 0) {
    // No rides exist — insert a temporary one to exercise the snapshot path,
    // then delete it (FK cascades the snapshot) so the DB is left clean.
    const rider = await pool.query(
      `SELECT id FROM users WHERE role = 'RIDER' LIMIT 1`
    );
    const ins = await pool.query(
      `INSERT INTO rides (rider_id, status, route_metadata)
       VALUES ($1, 'REQUESTED', '{}')
       RETURNING id`,
      [rider.rows.length ? rider.rows[0].id : null]
    );
    const tempId: string = ins.rows[0].id;
    tempRideId = tempId;
    rideId = tempId;
    snapInput = { distanceMeters: 5000, durationSeconds: 600 };
    console.log(`⚠ no rides existed — inserted temp ride ${rideId} for the snapshot round-trip`);
  } else {
    const r = ride.rows[0];
    rideId = r.id;
    snapInput = {
      distanceMeters: r.distance_meters ?? 5000,
      durationSeconds: r.duration_seconds ?? 600,
    };
  }

  const before = await pricingService.getSnapshotForRide(rideId);
  if (before) {
    // Existing snapshot — resolve must return exactly its final_fare.
    const resolved = await pricingService.resolveRideFare(rideId, snapInput);
    check('resolveRideFare returns existing snapshot fare', resolved === Number(before.final_fare), `snapshot=${before.final_fare} resolved=${resolved}`);
  } else {
    await pricingService.createPriceSnapshot(rideId, snapInput);
    const snap = await pricingService.getSnapshotForRide(rideId);
    check('createPriceSnapshot persisted row', snap !== null && snap.ride_id === rideId);
    const resolved = await pricingService.resolveRideFare(rideId, snapInput);
    check('resolveRideFare == snapshot final_fare (charged == quoted at request time)', snap !== null && resolved === Number(snap!.final_fare), `snapshot=${snap?.final_fare} resolved=${resolved}`);

    const sameInputEst = computeEstimate(snapInput);
    console.log(`  estimate.now=${sameInputEst.totalFare} vs snapshot.frozen=${snap?.final_fare}`);
  }

  if (tempRideId) {
    await pool.query(`DELETE FROM rides WHERE id = $1`, [tempRideId]);
    const leftover = await pool.query(`SELECT 1 FROM ride_price_snapshots WHERE ride_id = $1`, [tempRideId]);
    check('temp ride + snapshot cleaned up (FK cascade)', leftover.rows.length === 0);
  }

  await pool.end();
  console.log(failures === 0 ? '\nSMOKE TEST PASSED' : `\nSMOKE TEST FAILED (${failures} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('SMOKE TEST ERROR:', e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
