// e2e-cancel-rider.cjs — rider cancels an IN_PROGRESS ride; assert the
// driver's socket receives the CANCELLED tripUpdate with cancelled_by.
// Run after `node reset-env.cjs`.
require('dotenv').config();
const { io } = require('socket.io-client');
const BASE = 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}
async function http(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed, text: text.slice(0, 200) };
}
async function loginWithOtp(email, password) {
  const step1 = await http('POST', '/api/auth/login-password', { email, password });
  if (step1.status !== 200 || !step1.body?.otp_required) return step1;
  return http('POST', '/api/auth/verify-otp', { email, code: '111111' });
}
function socketConnect(token, role) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token, role }, transports: ['websocket', 'polling'], reconnection: false, timeout: 10000 });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`connect_error: ${e.message}`)));
  });
}
(async () => {
  const rider = await loginWithOtp('rider@NetRide.dev', 'password123');
  const driver = await loginWithOtp('driver@NetRide.dev', 'password123');
  ok('auth', !!rider.body?.token && !!driver.body?.token);

  const ds = await socketConnect(driver.body?.token, 'driver');
  let offer = null;
  ds.on('newTripRequest', (d) => { offer = d; });
  const driverUpdates = [];
  ds.on('tripUpdate', (d) => driverUpdates.push(d));
  ds.emit('goOnline', { lat: 34.0522, lng: -118.2437 });
  await sleep(1200);

  const rs = await socketConnect(rider.body?.token, 'rider');
  const riderUpdates = [];
  rs.on('tripUpdate', (d) => riderUpdates.push(d));

  const req = await http('POST', '/api/ride/request', {
    pickup: { lat: 34.0522, lng: -118.2437, address: 'LA' },
    destination: { lat: 34.0195, lng: -118.4912, address: 'Santa Monica' },
    vehicle_class: 'CORE',
  }, rider.body?.token);
  const tripId = req.body?.id;
  ok('ride requested', !!tripId, tripId);

  for (let i = 0; i < 16 && !offer; i++) await sleep(500);
  ok('driver got offer', !!offer, offer?.id === tripId ? 'match' : `mismatch ${offer?.id}`);

  const accept = await http('POST', '/api/ride/accept', { tripId }, driver.body?.token);
  ok('accepted', accept.status === 200 && accept.body?.status === 'ACCEPTED', accept.body?.status);
  await sleep(800);
  ds.emit('updateLocation', { lat: 34.0522, lng: -118.2437 });
  await sleep(500);
  ds.emit('pickUpRider', tripId);
  await sleep(1500);
  const cur = await http('GET', '/api/ride/current', null, driver.body?.token);
  ok('IN_PROGRESS', cur.body?.trip?.status === 'IN_PROGRESS', cur.body?.trip?.status);

  // RIDER CANCELS mid-ride (exactly what the rider app does: socket + REST)
  rs.emit('cancelTrip', { tripId, reasonCode: 'changed_plans' });
  const restCancel = await http('POST', '/api/ride/cancel', { tripId, reasonCode: 'changed_plans' }, rider.body?.token);
  ok('REST cancel ok', restCancel.status === 200 && restCancel.body?.cancelled === true, JSON.stringify(restCancel.body).slice(0, 80));

  await sleep(2000);
  const cancelled = driverUpdates.filter((d) => d.status === 'CANCELLED' && d.id === tripId);
  ok('driver socket received CANCELLED tripUpdate', cancelled.length > 0, `count=${cancelled.length}`);
  ok('cancelled_by is the rider', cancelled.length > 0 && cancelled[0].cancelled_by === rider.body?.user?.id, cancelled[0]?.cancelled_by);
  const riderCancelled = riderUpdates.filter((d) => d.status === 'CANCELLED' && d.id === tripId);
  ok('rider socket received CANCELLED', riderCancelled.length > 0, `count=${riderCancelled.length}`);

  ds.emit('goOffline');
  await sleep(300);
  ds.disconnect(); rs.disconnect();
  console.log(`CANCEL E2E: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('CRASH', e.message, e.stack); process.exit(1); });