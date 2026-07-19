const jwt = require('jsonwebtoken');
const JWT_SECRET = 'your-32-char-secret-replace-in-prod';
const ADMIN_ID = '04cbe31c-dc3c-41c6-a3f8-f793a1fa7c8e';
const BASE = process.env.BASE || 'http://localhost:3000/api';
const token = jwt.sign({ id: ADMIN_ID, role: 'ADMIN' }, JWT_SECRET, { expiresIn: '1h' });
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
(async () => {
  const usersRes = await fetch(`${BASE}/admin/users?limit=200`, { headers });
  const usersBody = await usersRes.json();
  const drivers = (usersBody.users || []).filter((u) => u.role === 'DRIVER' && u.driver_profile);
  let found = [];
  for (const d of drivers.slice(0, 40)) {
    const rp = await fetch(`${BASE}/admin/users/${d.id}/ride-preferences`, { headers });
    if (rp.status !== 200) continue;
    const b = await rp.json();
    if ((b.eligibleRideTypes || []).length > 1) found.push({ id: d.id, vc: b.vehicleClass, elig: b.eligibleRideTypes, prefs: b.preferences });
  }
  console.log('Drivers with multi-class eligibility:', JSON.stringify(found, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
