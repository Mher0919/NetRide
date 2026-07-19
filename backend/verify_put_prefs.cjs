const jwt = require('jsonwebtoken');
const JWT_SECRET = 'your-32-char-secret-replace-in-prod';
const ADMIN_ID = '04cbe31c-dc3c-41c6-a3f8-f793a1fa7c8e';
const BASE = process.env.BASE || 'http://localhost:3000/api';
// admin endpoint is read-only; we need a driver token. Mint one with admin secret
// (the app verifies HS256 with the same secret) using driver role.
const token = jwt.sign({ id: '5d3251d9-c5fe-49e8-8689-0679fd75330a', role: 'DRIVER' }, JWT_SECRET, { expiresIn: '1h' });
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
(async () => {
  const get = await fetch(`${BASE}/driver/ride-preferences`, { headers });
  console.log('GET status', get.status);
  const body = await get.json();
  console.log('GET body', JSON.stringify(body));
  // Toggle CORE off then back on to prove PUT persists.
  const put = await fetch(`${BASE}/driver/ride-preferences`, { method: 'PUT', headers, body: JSON.stringify({ enabled: [] }) });
  console.log('PUT(off) status', put.status, JSON.stringify(await put.json()));
  const put2 = await fetch(`${BASE}/driver/ride-preferences`, { method: 'PUT', headers, body: JSON.stringify({ enabled: ['CORE'] }) });
  console.log('PUT(on) status', put2.status, JSON.stringify(await put2.json()));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
