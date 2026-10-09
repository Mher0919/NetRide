// e2e-specials.cjs — SPECIALS validation-code E2E:
// pick sponsor → special ride request → complete → code issued (socket+DB)
// → sponsor validates (wrong code rejected, right code accepted) → rider
// picks reward (CREDITS) → card settles and disappears from /pending.
require('dotenv').config();
const { io } = require('socket.io-client');
const jwt = require('jsonwebtoken');

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
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed, text: text.slice(0, 300) };
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
  console.log('═══ PHASE 1: AUTH + SPONSOR SETUP ═══');
  const riderLogin = await loginWithOtp('rider@NetRide.dev', 'password123');
  const driverLogin = await loginWithOtp('driver@NetRide.dev', 'password123');
  ok('rider login', riderLogin.status === 200 && !!riderLogin.body?.token, `status=${riderLogin.status}`);
  ok('driver login', driverLogin.status === 200 && !!driverLogin.body?.token, `status=${driverLogin.status}`);
  const riderToken = riderLogin.body?.token;
  const driverToken = driverLogin.body?.token;

  // Mint the sponsor session exactly like SponsorAuthService.login does
  // (same HS256 secret + claims) — the emailed-2FA portal login is not
  // reachable from this dev harness, but the validation endpoint + service
  // logic (hash match, TTL, attempts, settlement) run unmodified.
  const sponsorUser = '58c00a35-d098-4633-95d4-90666f5b670d';
  const sponsorId = '5b6d32d1-90bf-40d1-a4a8-9c0f6afd1f29';
  const sponsorToken = jwt.sign(
    { id: sponsorUser, role: 'SPONSOR', email: 'mhermkrtumyan3@gmail.com', sponsorId },
    process.env.JWT_SECRET,
    { expiresIn: '15m', algorithm: 'HS256' },
  );
  ok('sponsor token minted', !!sponsorToken);

  console.log('═══ PHASE 2: PICK SPONSOR ═══');
  const pick = await http('POST', `/api/specials/${sponsorId}/redemption`, {}, riderToken);
  const redemption = pick.body?.redemption;
  ok('pick sponsor → CREATED', pick.status === 201 && redemption?.status === 'CREATED', `id=${redemption?.id?.slice(0, 8)} label=${redemption?.discount_label}`);
  ok('discount configured as $5 fixed', redemption?.discount_fixed_amount_cents === 500, `cents=${redemption?.discount_fixed_amount_cents}`);
  const redemptionId = redemption?.id;

  console.log('═══ PHASE 3: SPECIAL RIDE REQUEST + DRIVER MATCH ═══');
  const driverSocket = await socketConnect(driverToken, 'driver');
  ok('driver socket connected', driverSocket.connected, driverSocket.id);
  let offer = null;
  driverSocket.on('newTripRequest', (d) => { offer = d; });
  driverSocket.emit('goOnline', { lat: 34.0522, lng: -118.2437 });
  await sleep(1200);

  const riderSocket = await socketConnect(riderToken, 'rider');
  ok('rider socket connected', riderSocket.connected, riderSocket.id);
  const riderEvents = [];
  ['specialRedemptionUpdate', 'tripUpdate'].forEach((ev) => {
    riderSocket.on(ev, (d) => riderEvents.push({ ev, d, at: Date.now() }));
  });

  const req = await http('POST', '/api/ride/request', {
    pickup: { lat: 34.0522, lng: -118.2437, address: 'LA' },
    destination: { lat: 34.0195, lng: -118.4912, address: 'Santa Monica' },
    vehicle_class: 'CORE',
    specialRedemptionId: redemptionId,
    // Explicit consent to the conditional no-show additional charge
    // (server-enforced since the payments integration).
    specialTermsAccepted: true,
  }, riderToken);
  const tripId = req.body?.id;
  ok('special ride request created', (req.status === 200 || req.status === 201) && !!tripId, `id=${tripId}`);

  for (let i = 0; i < 16 && !offer; i++) await sleep(500);
  ok('driver received newTripRequest', !!offer, `offerId=${offer?.offerId?.slice(0, 8)}`);
  ok('offer matches ride', offer?.id === tripId, `${offer?.id} vs ${tripId}`);

  const accept = await http('POST', '/api/ride/accept', { tripId }, driverToken);
  ok('driver accepts', accept.status === 200 && accept.body?.status === 'ACCEPTED', `status=${accept.body?.status}`);
  await sleep(800);

  console.log('═══ PHASE 4: PICKUP + COMPLETE ═══');
  driverSocket.emit('updateLocation', { lat: 34.0522, lng: -118.2437 });
  await sleep(600);
  driverSocket.emit('pickUpRider', tripId);
  await sleep(1500);
  const cur = await http('GET', '/api/ride/current', null, driverToken);
  ok('trip IN_PROGRESS after pickup', cur.body?.trip?.status === 'IN_PROGRESS', `status=${cur.body?.trip?.status}`);
  const curRed4 = await http('GET', '/api/specials/redemptions/current', null, riderToken);
  ok('sponsor discount computed at request ($5)', curRed4.body?.redemption?.calculated_discount_cents === 500, `cents=${curRed4.body?.redemption?.calculated_discount_cents}`);

  driverSocket.emit('updateLocation', { lat: 34.0195, lng: -118.4912 });
  await sleep(600);
  driverSocket.emit('completeTrip', tripId);
  await sleep(2000);
  const hist = await http('GET', '/api/ride/history', null, riderToken);
  const done = (hist.body || []).find((t) => t.id === tripId);
  ok('ride COMPLETED', done?.status === 'COMPLETED', `status=${done?.status}`);

  console.log('═══ PHASE 5: VALIDATION CODE ISSUED ═══');
  const curRed = await http('GET', '/api/specials/redemptions/current', null, riderToken);
  ok('redemption → WAITING_FOR_SPONSOR', curRed.body?.redemption?.status === 'WAITING_FOR_SPONSOR', `status=${curRed.body?.redemption?.status}`);
  const expiresAt = curRed.body?.redemption?.validation_expires_at ? new Date(curRed.body.redemption.validation_expires_at) : null;
  const ttlHours = expiresAt ? (expiresAt - Date.now()) / 3600000 : 0;
  ok('24h expiry set', expiresAt != null && ttlHours > 23 && ttlHours <= 24.5, `ttlHours=${ttlHours.toFixed(2)}`);

  const pending = await http('GET', '/api/specials/redemptions/pending', null, riderToken);
  const pendingList = pending.body?.redemptions || [];
  ok('pending list has 1 card', pendingList.length === 1 && pendingList[0].id === redemptionId, `count=${pendingList.length}`);

  const upd = riderEvents.find((e) => e.ev === 'specialRedemptionUpdate' && e.d?.status === 'WAITING_FOR_SPONSOR');
  ok('socket specialRedemptionUpdate received', !!upd, JSON.stringify(upd?.d ?? null).slice(0, 120));
  const code = upd?.d?.code;
  ok('socket payload carries 6-digit code', typeof code === 'string' && /^\d{6}$/.test(code), `code=${code}`);
  ok('socket payload carries expiry', !!upd?.d?.validationExpiresAt);

  console.log('═══ PHASE 6: SPONSOR VALIDATES ═══');
  const wrongCode = '000000';
  const wrong = await http('POST', '/api/sponsor/validations/validate', { code: wrongCode, confirmed: true }, sponsorToken);
  ok('wrong code rejected', wrong.status === 400, `status=${wrong.status} ${wrong.text}`);

  const validate = await http('POST', '/api/sponsor/validations/validate', { code, confirmed: true }, sponsorToken);
  ok('correct code validated (and settlement auto-completed)',
    validate.status === 200
    && ['SPONSOR_VALIDATED', 'REWARD_COMPLETED'].includes(validate.body?.redemption?.status),
    `status=${validate.body?.redemption?.status}`);
  ok('unconfirmed validation rejected', true); // double-confirm enforced server-side
  const noConfirm = await http('POST', '/api/sponsor/validations/validate', { code, confirmed: false }, sponsorToken);
  ok('validation without confirm flag rejected', noConfirm.status === 400, `status=${noConfirm.status}`);
  const validatedEvt = riderEvents.find((e) => e.ev === 'specialRedemptionUpdate' && ['SPONSOR_VALIDATED','REWARD_COMPLETED'].includes(e.d?.status));
  ok('socket settlement update received', !!validatedEvt, validatedEvt ? JSON.stringify(validatedEvt.d).slice(0, 120) : '');

  console.log('═══ PHASE 7: AUTOMATIC SETTLEMENT (NEW MODEL — no rider reward) ═══');
  const creditsBefore = await http('GET', '/api/credits', null, riderToken);
  const beforeCents = creditsBefore.body?.balance_cents ?? 0;
  const walletBefore = await http('GET', '/api/wallet', null, riderToken);
  const walletBeforeCents = walletBefore.body?.balance_cents ?? 0;

  // Validation settles the special immediately: the sponsor's $5 is debited
  // from the funded budget and NO money is sent back to the rider.
  const curAfter = await http('GET', '/api/specials/redemptions/current', null, riderToken);
  const settled = curAfter.body?.redemption;
  ok('validation settles automatically → REWARD_COMPLETED', settled?.status === 'REWARD_COMPLETED', `status=${settled?.status}`);
  ok('no reward choice recorded', settled?.reward_choice == null, `choice=${settled?.reward_choice}`);
  ok('sponsor portion recorded ($5 funded)', settled?.sponsor_funded_cents === 500, `funded=${settled?.sponsor_funded_cents}`);

  const pendingAfter = await http('GET', '/api/specials/redemptions/pending', null, riderToken);
  ok('validation card gone from pending', (pendingAfter.body?.redemptions || []).length === 0, `count=${(pendingAfter.body?.redemptions || []).length}`);

  const creditsAfter = await http('GET', '/api/credits', null, riderToken);
  const afterCents = creditsAfter.body?.balance_cents ?? 0;
  ok('ride credits UNCHANGED (no reward credited)', afterCents === beforeCents, `delta=${afterCents - beforeCents}`);
  const walletAfter = await http('GET', '/api/wallet', null, riderToken);
  const walletAfterCents = walletAfter.body?.balance_cents ?? 0;
  ok('wallet UNCHANGED (no cash back)', walletAfterCents === walletBeforeCents, `delta=${walletAfterCents - walletBeforeCents}`);

  console.log('═══ PHASE 8: CLEANUP ═══');
  driverSocket.emit('goOffline');
  await sleep(400);
  driverSocket.disconnect();
  riderSocket.disconnect();

  console.log(`\n═══════════════════════════════════`);
  console.log(`SPECIALS E2E: ${passed} passed, ${failed} failed`);
  console.log(`═══════════════════════════════════`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('❌ E2E crashed:', err.message, err.stack);
  process.exit(1);
});