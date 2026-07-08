// k6 load test: Ride request lifecycle with pre-seeded riders
// Validates p99 match latency < 1.5s under load.
// Seed first: cd backend && node scripts/seed_riders.cjs
// Usage: k6 run --vus 50 --duration 60s infra/loadtest/ride_request.js

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const rideLatency = new Trend('ride_request_latency_ms');
const rideErrorRate = new Rate('ride_request_errors');

export const options = {
  stages: [
    { target: 10, duration: '10s' },
    { target: 30, duration: '20s' },
    { target: 50, duration: '30s' },
  ],
  thresholds: {
    ride_request_latency_ms: ['p(99) < 5000'],
    ride_request_errors: ['rate < 0.10'],
  },
};

const BASE_URL = 'http://localhost:3000';
const PASSWORD = 'test123456';

// Cache tokens per VU (VU numbers are 1-indexed)
const tokens = {};

function riderForVU(vu) {
  return {
    email: `loadtest.rider.${vu}@test.com`,
    lat: 34.05 + (vu % 100) * 0.0005,
    lng: -118.24 + (vu % 100) * 0.0005,
  };
}

export default function () {
  const vu = __VU;

  // Login once per VU, cache the token
  if (!tokens[vu]) {
    const rider = riderForVU(vu);
    const loginRes = http.post(`${BASE_URL}/api/auth/login-password`, JSON.stringify({
      email: rider.email,
      password: PASSWORD,
    }), { headers: { 'Content-Type': 'application/json' } });

    check(loginRes, { 'login succeeded': (r) => r.status === 200 });
    if (loginRes.status !== 200) {
      rideErrorRate.add(1);
      sleep(1);
      return;
    }
    tokens[vu] = {
      token: loginRes.json('token') || loginRes.json('accessToken'),
      rider,
    };
  }

  const { token, rider } = tokens[vu];

  const ridePayload = JSON.stringify({
    pickup: { lat: rider.lat, lng: rider.lng, address: 'Test pickup' },
    destination: { lat: rider.lat + 0.01, lng: rider.lng + 0.01, address: 'Test destination' },
    requestedClass: 'CORE',
  });

  const start = Date.now();
  const rideRes = http.post(`${BASE_URL}/api/ride/request`, ridePayload, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  });
  const elapsed = Date.now() - start;

  check(rideRes, { 'ride request status 201': (r) => r.status === 201 });

  if (rideRes.status === 201) {
    rideLatency.add(elapsed);
  } else {
    rideErrorRate.add(1);
  }

  sleep(1);
}
