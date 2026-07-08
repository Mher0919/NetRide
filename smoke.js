// smoke.js — End-to-end smoke test for the navigation system.
// 1. Rider logs in, requests a trip
// 2. Driver logs in, goes online via socket (with face gate)
// 3. Driver receives newTripRequest
// 4. Driver accepts via REST
// 5. Verify pickup-leg route was cached in Redis
// 6. Test the reroute REST endpoint
// 7. Test IN_PROGRESS transition via status update
// 8. Verify destination-leg route was cached
const { io } = require('C:/Users/mmkrt/AppData/Local/Temp/node_modules/socket.io-client');

async function http(method, path, body, token) {
  const res = await fetch(`http://localhost:3000${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

(async () => {
  console.log('--- 1. Rider login ---');
  const riderLogin = await http('POST', '/api/auth/login-password', {
    email: 'rider@NetRide.dev', password: 'password123',
  });
  const riderToken = riderLogin.body.token;
  console.log('  rider token:', riderToken?.slice(0, 30));

  console.log('--- 2. Driver login ---');
  const driverLogin = await http('POST', '/api/auth/login-password', {
    email: 'driver@NetRide.dev', password: 'password123',
  });
  const driverToken = driverLogin.body.token;
  const driverId = driverLogin.body.user.id;
  console.log('  driver id:', driverId);

  console.log('--- 3. Driver socket connect + goOnline ---');
  const driverSocket = io('http://localhost:3000', {
    auth: { token: driverToken },
    transports: ['websocket', 'polling'],
  });

  await new Promise((resolve, reject) => {
    driverSocket.on('connect', () => {
      console.log('  socket connected:', driverSocket.id);
      driverSocket.emit('goOnline', {
        lat: 34.0400, lng: -118.2500, // ~1.5km from pickup so the route has steps
      });
      setTimeout(resolve, 800);
    });
    driverSocket.on('connect_error', (err) => reject(err));
  });

  console.log('--- 4. Rider requests trip ---');
  // Subscribe BEFORE requesting so we don't miss the offer.
  let tripRequest = null;
  driverSocket.on('newTripRequest', (data) => {
    console.log('  newTripRequest received:', data.id, 'price:', data.calculated_price);
    tripRequest = data;
  });

  const rideRes = await http('POST', '/api/ride/request', {
    pickup: { lat: 34.0522, lng: -118.2437, address: 'LA' },
    destination: { lat: 34.0195, lng: -118.4912, address: 'Santa Monica' },
    vehicle_class: 'CORE',
  }, riderToken);
  const tripId = rideRes.body.id;
  console.log('  trip id:', tripId, 'status:', rideRes.body.status);

  console.log('--- 5. Wait for newTripRequest on driver socket ---');
  await new Promise((r) => setTimeout(r, 2500));

  if (!tripRequest) {
    console.log('  ❌ No newTripRequest received — driver too far or face gate failed');
    driverSocket.disconnect();
    process.exit(1);
  }

  console.log('--- 6. Driver accepts trip via REST ---');
  const acceptRes = await http('POST', '/api/ride/accept', { tripId }, driverToken);
  console.log('  accept status:', acceptRes.status, 'trip status:', acceptRes.body.status, 'driver_id:', acceptRes.body.driver_id?.slice(0, 8));

  console.log('--- 7. Verify pickup route cached in Redis ---');
  const { execSync } = require('child_process');
  const pickupKey = `trip_route:${tripId}:pickup`;
  const pickupRaw = execSync(`docker exec netride-redis-1 redis-cli GET "${pickupKey}"`, { encoding: 'utf8' }).toString();
  if (pickupRaw && pickupRaw !== '(nil)') {
    const cached = JSON.parse(pickupRaw);
    console.log('  pickup cached: distance=', cached.distance, 'steps=', cached.steps?.length, 'speedLimitsByRoad keys=', Object.keys(cached.speedLimitsByRoad || {}).length);
  } else {
    console.log('  ❌ pickup NOT cached');
  }

  console.log('--- 8. Driver moves to pickup location + picks up rider (IN_PROGRESS) ---');
  // The proximity gate requires the driver to be within DRIVER_PICKUP_PROXIMITY_M
  // of the pickup before pickUpRider is allowed. Send an updateLocation first.
  driverSocket.emit('updateLocation', { lat: 34.0522, lng: -118.2437 });
  await new Promise((r) => setTimeout(r, 500));
  driverSocket.emit('pickUpRider', tripId);
  await new Promise((r) => setTimeout(r, 1500));

  const tripAfterPickup = await http('GET', `/api/ride/history`, null, riderToken);
  const tripStatus = tripAfterPickup.body?.find?.((t) => t.id === tripId)?.status;
  console.log('  trip status after pickup:', tripStatus);

  let destRaw;
  try {
    destRaw = execSync(`docker exec netride-redis-1 redis-cli GET "trip_route:${tripId}:destination"`, { encoding: 'utf8' }).toString().trim();
  } catch {}
  if (destRaw && destRaw !== '(nil)') {
    try {
      const c = JSON.parse(destRaw);
      console.log('  ✅ destination cached: distance=', c.distance, 'steps=', c.steps?.length, 'speedLimitsByRoad keys=', Object.keys(c.speedLimitsByRoad || {}).length);
    } catch (e) {
      console.log('  ❌ destination cache parse error:', destRaw.slice(0, 80));
    }
  } else {
    console.log('  ❌ destination NOT cached (trip may not have advanced to IN_PROGRESS)');
  }

  console.log('--- 9. Test reroute REST endpoint ---');
  const rerouteRes = await http('POST', '/api/navigation/reroute', {
    tripId, leg: 'pickup', lat: 34.0522, lng: -118.2437,
  }, driverToken);
  console.log('  reroute status:', rerouteRes.status);
  if (rerouteRes.body?.route) {
    console.log('  reroute returned route: distance=', rerouteRes.body.route.distance, 'steps=', rerouteRes.body.route.steps?.length);
  } else {
    console.log('  reroute response:', JSON.stringify(rerouteRes.body).slice(0, 200));
  }

  console.log('--- 10. Test cached route GET endpoint ---');
  const cachedRes = await http('GET', `/api/navigation/cached?tripId=${tripId}&leg=pickup`, null, driverToken);
  console.log('  cached GET status:', cachedRes.status);
  if (cachedRes.body?.route) {
    console.log('  cached route distance:', cachedRes.body.route.distance, 'cachedAt:', cachedRes.body.route.cachedAt);
  }

  driverSocket.disconnect();
  console.log('\n✅ Smoke test complete');
  process.exit(0);
})().catch((err) => {
  console.error('❌ Smoke test failed:', err.message, err.stack);
  process.exit(1);
});