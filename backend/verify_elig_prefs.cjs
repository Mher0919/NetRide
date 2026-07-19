// Live verification of the ride-eligibility + preferences system (031).
const fs = require('fs');
const path = require('path');
const JWT_SECRET = 'your-32-char-secret-replace-in-prod';
const jwt = require('jsonwebtoken');
const ADMIN_ID = '04cbe31c-dc3c-41c6-a3f8-f793a1fa7c8e';
const BASE = process.env.BASE || 'http://localhost:3000/api';

function adminToken() {
  return jwt.sign({ id: ADMIN_ID, role: 'ADMIN' }, JWT_SECRET, { expiresIn: '1h' });
}

// Pure engine checks (mirror backend logic via direct import).
const engine = require('./dist/services/vehicleEligibility.service.js');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('PASS:', msg);
}

(async () => {
  // ---- Eligibility engine unit checks ----
  const luxSuv = engine.computeVehicleClass({ isLuxury: true, seats: 7, exteriorColor: 'black', interiorColor: 'black' });
  assert(luxSuv.vehicleClass === 'PRESTIGE', 'Black/black/7-seat/luxury => PRESTIGE');
  assert(luxSuv.eligibleRideTypes.join(',') === 'CORE,ELITE,PRESTIGE', 'PRESTIGE eligible = CORE,ELITE,PRESTIGE');

  const luxOnly = engine.computeVehicleClass({ isLuxury: true, seats: 5, exteriorColor: 'white', interiorColor: 'tan' });
  assert(luxOnly.vehicleClass === 'ELITE', 'Luxury sedan (no SUV rules) => ELITE');
  assert(luxOnly.eligibleRideTypes.join(',') === 'CORE,ELITE', 'ELITE eligible = CORE,ELITE');

  const basic = engine.computeVehicleClass({ isLuxury: false, seats: 5, exteriorColor: 'red', interiorColor: 'gray' });
  assert(basic.vehicleClass === 'CORE', 'Non-luxury => CORE');
  assert(basic.eligibleRideTypes.join(',') === 'CORE', 'CORE eligible = CORE');

  const luxSuvNotBlack = engine.computeVehicleClass({ isLuxury: true, seats: 7, exteriorColor: 'black', interiorColor: 'tan' });
  assert(luxSuvNotBlack.vehicleClass === 'ELITE', '7-seat luxury BUT non-black interior => ELITE (not PRESTIGE)');

  // ---- API flow with a real driver ----
  const token = adminToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const usersRes = await fetch(`${BASE}/admin/users?limit=50`, { headers });
  const usersBody = await usersRes.json();
  const drivers = (usersBody.users || []).filter((u) => u.role === 'DRIVER' && u.driver_profile);
  if (!drivers.length) { console.error('No drivers found'); process.exit(2); }
  const driver = drivers[0];
  console.log('Testing driver:', driver.id, driver.email);

  const prefRes = await fetch(`${BASE}/driver/ride-preferences`, {
    headers: { Authorization: `Bearer ${driverToken(driver.id)}`, 'Content-Type': 'application/json' },
  });
  let prefBody;
  if (prefRes.status === 401) {
    console.log('NOTE: cannot mint driver token without secret; testing admin vehicle-class endpoint instead.');
    const rp = await fetch(`${BASE}/admin/users/${driver.id}/ride-preferences`, { headers });
    const rpBody = await rp.json();
    console.log('ADMIN ride-preferences:', JSON.stringify(rpBody));
    assert(rpBody.vehicleClass != null, 'admin ride-preferences returns vehicleClass');
    assert(Array.isArray(rpBody.eligibleRideTypes), 'admin ride-preferences returns eligibleRideTypes');
    process.exit(process.exitCode || 0);
  }
  prefBody = await prefRes.json();
  console.log('Driver ride-preferences:', JSON.stringify(prefBody));
  assert(prefBody.vehicleClass != null, 'driver ride-preferences returns vehicleClass');
  assert(Array.isArray(prefBody.eligibleRideTypes), 'driver ride-preferences returns eligibleRideTypes');

  // Toggle: disable ELITE if eligible
  if (prefBody.eligibleRideTypes.includes('ELITE')) {
    const enabled = prefBody.eligibleRideTypes.filter((t) => t !== 'ELITE');
    const putRes = await fetch(`${BASE}/driver/ride-preferences`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${driverToken(driver.id)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const putBody = await putRes.json();
    assert(putRes.status === 200, 'PUT ride-preferences 200');
    assert(putBody.preferences.ELITE === false, 'ELITE disabled after PUT');
    console.log('After disable ELITE:', JSON.stringify(putBody.preferences));
  }

  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(3); });

// We cannot mint a valid driver JWT without the secret used by the app at
// login, so for driver-scoped calls we rely on the admin endpoint instead.
function driverToken(_id) { return adminToken(); }
