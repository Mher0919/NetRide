require('dotenv').config();
const { io } = require('C:/Users/mmkrt/OneDrive/Desktop/NetRide/apps/admin_dashboard/node_modules/socket.io-client');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'http://localhost:3000';

async function http(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

(async () => {
  const riderLogin = await http('POST', '/api/auth/login-password', { email: 'rider@NetRide.dev', password: 'password123' });
  const riderTok = (await http('POST', '/api/auth/verify-otp', { email: 'rider@NetRide.dev', code: '111111' })).body.token;
  const driverTok = (await http('POST', '/api/auth/verify-otp', { email: 'driver@NetRide.dev', code: '111111' })).body.token;

  const s = io(BASE, { auth: { token: driverTok, role: 'driver' }, transports: ['websocket', 'polling'], reconnection: false });
  s.onAny((event, ...args) => console.log(`[EVENT] ${event}:`, JSON.stringify(args).slice(0, 200)));
  s.on('connect', async () => {
    console.log('connected', s.id);
    s.emit('goOnline', { lat: 34.0400, lng: -118.2500 });
    await sleep(1000);
    const ride = await http('POST', '/api/ride/request', {
      pickup: { lat: 34.0522, lng: -118.2437, address: 'LA' },
      destination: { lat: 34.0195, lng: -118.4912, address: 'Santa Monica' },
      vehicle_class: 'CORE',
    }, riderTok);
    console.log('ride:', ride.status, ride.body?.id, ride.body?.status);
    await sleep(5000);
    console.log('--- done waiting ---');
    process.exit(0);
  });
  s.on('connect_error', (e) => { console.error('connect_error', e.message); process.exit(1); });
})().catch((e) => { console.error('crash', e.message); process.exit(1); });