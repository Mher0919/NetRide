require('dotenv').config();
(async () => {
  for (const email of ['rider@NetRide.dev', 'driver@NetRide.dev']) {
    const res = await fetch('http://localhost:3000/api/auth/login-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123' }),
    });
    const text = await res.text();
    console.log(email, 'status:', res.status);
    console.log('  body:', text.slice(0, 400));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });