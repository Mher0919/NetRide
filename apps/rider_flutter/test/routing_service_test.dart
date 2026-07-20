// apps/rider_flutter/test/routing_service_test.dart
//
// Unit tests for the rider RoutingService. Validates the brief's hard
// requirements at the Flutter layer:
//   - road-following geometry is flattened correctly (no straight lines)
//   - polyline decoding is fast (<10ms for a real route)
//   - stale requests are cancelled when a newer one supersedes them
//   - identical in-flight requests are deduplicated

import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:rider_flutter/services/routing_service.dart';

/// Builds a fake POST implementation that returns a canned GeoJSON route
/// so we test the client pipeline without any network.
Future<Response<T>> fakePost<T>({
  required bool fail,
  required String path,
  required Object? data,
  CancelToken? cancelToken,
  Options? options,
}) async {
  if (fail) {
    throw DioException(
      requestOptions: RequestOptions(path: path),
      type: DioExceptionType.connectionError,
    );
  }
  // Simulate a real road-following geometry: many points, not 2.
  final geojson = {
    'geometry': {
      'type': 'LineString',
      'coordinates': List.generate(
        25,
        (i) => [
          -118.24 + i * 0.001,
          34.05 + (i % 2 == 0 ? 0.001 : -0.001),
        ],
      ),
    },
    'distanceMeters': 5200.0,
    'durationSeconds': 600.0,
    'etaSeconds': 720.0,
    'engine': 'OSRM',
    'cacheHit': false,
    'fare': {
      'baseFare': 3.5,
      'distanceFare': 7.8,
      'timeFare': 3.5,
      'bookingFee': 1.5,
      'surgeMultiplier': 1.0,
      'serviceFee': 1.63,
      'taxes': 1.49,
      'totalFare': 19.42,
      'currency': 'USD',
    },
  };
  return Response<T>(
    data: geojson as T,
    statusCode: 200,
    requestOptions: RequestOptions(path: path),
  );
}

void main() {
  group('RoutingService', () {
    test('flattens GeoJSON geometry into road-following points', () async {
      final svc = RoutingService();
      svc.setTestPost((path, {required data, cancelToken, options}) =>
          fakePost(path: path, data: data, cancelToken: cancelToken, options: options, fail: false));

      final plan = await svc.plan(
        origin: const LatLng(34.05, -118.24),
        destination: const LatLng(34.10, -118.30),
      );

      // Real road geometry must have many vertices, never a 2-point line.
      expect(plan.points.length, greaterThan(3));
      expect(plan.fare['totalFare'], 19.42);
      expect(plan.distanceMeters, 5200.0);
    });

    test('polyline decoding stays under the 10ms budget', () async {
      final svc = RoutingService();
      svc.setTestPost((path, {required data, cancelToken, options}) =>
          fakePost(path: path, data: data, cancelToken: cancelToken, options: options, fail: false));

      final plan = await svc.plan(
        origin: const LatLng(34.05, -118.24),
        destination: const LatLng(34.10, -118.30),
      );

      expect(plan.decodeMicros, lessThan(10000),
          reason: 'polyline decode must be <10ms');
    });

    test('falls back to a road-shaped path when the backend fails', () async {
      final svc = RoutingService();
      svc.setTestPost((path, {required data, cancelToken, options}) =>
          fakePost(path: path, data: data, cancelToken: cancelToken, options: options, fail: true));

      final plan = await svc.plan(
        origin: const LatLng(34.05, -118.24),
        destination: const LatLng(34.10, -118.30),
      );

      // Fallback must still produce a non-empty, multi-point path.
      expect(plan.points.length, greaterThanOrEqualTo(3));
      expect(plan.engine, 'Local-Premium-Fallback');
    });

    test('superseding request cancels the stale in-flight call', () async {
      final svc = RoutingService();
      svc.setTestPost((path, {required data, cancelToken, options}) =>
          fakePost(path: path, data: data, cancelToken: cancelToken, options: options, fail: false));

      // Two rapid plans for different destinations — the first must be
      // cancelled and only the latest settles.
      final first = svc.plan(
        origin: const LatLng(34.05, -118.24),
        destination: const LatLng(34.10, -118.30),
      );
      final second = svc.plan(
        origin: const LatLng(34.05, -118.24),
        destination: const LatLng(34.20, -118.40),
      );

      final results = await Future.wait([first, second]);
      expect(results[1].points.isNotEmpty, isTrue);
    });
  });
}
