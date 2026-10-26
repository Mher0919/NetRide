// test/route_cache_test.dart
//
// Regression guard: the local route cache must preserve polyline geometry.
// A previous cache payload omitted it, so the second use of a route returned
// a route with ZERO points — the driver map then had no route line at all.

import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:latlong2/latlong.dart';
import 'package:driver_flutter/models/route_models.dart';
import 'package:driver_flutter/services/route_cache_service.dart';
import 'package:driver_flutter/utils/spatial_hash.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('disk cache round-trips polyline and steps', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final cache = RouteCacheService.instance;
    await cache.clearAll();
    await cache.init(prefs);

    final route = RouteResponse(
      originHex: SpatialHash.encode(34.0500, -118.2500),
      destHex: SpatialHash.encode(34.0520, -118.2520),
      distanceMeters: 1200,
      durationSeconds: 300,
      trafficDurationSeconds: 360,
      polyline: const [
        LatLng(34.0500, -118.2500),
        LatLng(34.0510, -118.2510),
        LatLng(34.0520, -118.2520),
      ],
      steps: const [
        RouteStep(
          distanceMeters: 1200,
          durationSeconds: 300,
          instruction: 'Turn right onto Main St',
          maneuver: 'TURN_RIGHT',
          polyline: [],
        ),
      ],
      engine: 'GoogleRoutes',
      cacheHit: false,
    );

    await cache.set(route);
    // Simulate a fresh process: snapshot the disk entries, clear the memory
    // cache, restore the disk rows, then read through a newly initialized
    // service. This exercises the disk deserializer (the original bug).
    final disk = {
      for (final key in prefs.getKeys().where(
        (k) => k.startsWith('route_cache_v2:'),
      ))
        key: prefs.getString(key),
    };
    expect(disk, isNotEmpty);
    await cache.clearAll();
    for (final entry in disk.entries) {
      await prefs.setString(entry.key, entry.value!);
    }
    await cache.init(prefs);

    final hit = cache.get(
      originLat: 34.0500,
      originLng: -118.2500,
      destLat: 34.0520,
      destLng: -118.2520,
    );
    expect(hit, isNotNull);
    expect(hit!.polyline, hasLength(3));
    expect(hit.steps, hasLength(1));
    expect(hit.steps.first.instruction, 'Turn right onto Main St');
  });

  test('legacy geometry-less cache rows are treated as a miss', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final cache = RouteCacheService.instance;
    await cache.clearAll();
    await cache.init(prefs);

    const oLat = 34.06, oLng = -118.26, dLat = 34.07, dLng = -118.27;
    final key =
        'route_cache_v2:route:${SpatialHash.encode(oLat, oLng)}:${SpatialHash.encode(dLat, dLng)}';
    await prefs.setString(
      key,
      jsonEncode({
        'originHex': SpatialHash.encode(oLat, oLng),
        'destHex': SpatialHash.encode(dLat, dLng),
        'distanceMeters': 900,
        'durationSeconds': 180,
        'trafficDurationSeconds': null,
        'steps': <dynamic>[],
        'engine': 'cache',
        'cachedAt': DateTime.now().toIso8601String(),
      }),
    );

    final hit = cache.get(
      originLat: oLat,
      originLng: oLng,
      destLat: dLat,
      destLng: dLng,
    );
    expect(hit, isNull);
    expect(prefs.getString(key), isNull);
  });
}
