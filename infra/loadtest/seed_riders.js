// Seed 100 rider accounts for load testing.
// Usage: node infra/loadtest/seed_riders.js

const http = require('http');

const BASE_URL = 'http://localhost:3000';
const PASSWORD = 'test123456';

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(path, BASE_URL);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const total = 100;
  let created = 0;
  for (let i = 0; i < total; i++) {
    const email = `loadtest.rider.${i}@test.com`;
    const res = await post('/api/auth/signup-password', {
      email,
      full_name: `Load Rider ${i}`,
      password: PASSWORD,
      role: 'RIDER',
    });
    if (res.status === 200) {
      created++;
    }
    // Print progress every 10 riders
    if ((i + 1) % 10 === 0 || i === total - 1) {
      console.log(`[${i + 1}/${total}] ${created} created so far (${res.status}: ${email})`);
    }
  }
  console.log(`\nDone. ${created} riders created.`);
}

main().catch(console.error);
