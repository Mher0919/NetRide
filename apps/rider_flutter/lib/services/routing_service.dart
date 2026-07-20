import 'dart:async';
import 'dart:io';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:latlong2/latlong.dart';

/// Result of a trip-plan call: road-following geometry + ETA + full fare.
class TripPlan {
  const TripPlan({
    required this.points,
    required this.distanceMeters,
    required this.durationSeconds,
    required this.etaSeconds,
    required this.fare,
    required this.engine,
    required this.cacheHit,
    required this.decodeMicros,
  });

  final List<LatLng> points;
  final double distanceMeters;
  final double durationSeconds;
  final double etaSeconds;
  final Map<String, dynamic> fare;
  final String engine;
  final bool cacheHit;
  /// Polyline-decode time in microseconds (instrumented for perf budgets).
  final int decodeMicros;
}

class RoutingService {
  final Dio _dio = Dio();

  /// Test seam: lets widget/unit tests inject a fake POST implementation
  /// without touching the network. Production code never sets this.
  void setTestPost(Future<Response> Function(
    String path, {
    required Object? data,
    CancelToken? cancelToken,
    Options? options,
  }) post) =>
      _testPost = post;
  Future<Response> Function(
    String path, {
    required Object? data,
    CancelToken? cancelToken,
    Options? options,
  })? _testPost;

  // API Gateway URL.
  final String _baseUrl = 'https://netride.onrender.com';

  /// In-flight request token per (origin+destination+class) so we can cancel
  /// stale calls when the rider changes the destination mid-typing.
  final Map<String, CancelToken> _inflight = {};

  /// Dedupe identical in-flight plans so a rapid re-tap doesn't double-call.
  final Map<String, Future<TripPlan>> _dedupe = {};

  Future<TripPlan> plan({
    required LatLng origin,
    required LatLng destination,
    String vehicleClass = 'CORE',
  }) async {
    final key =
        '${origin.latitude},${origin.longitude}|${destination.latitude},${destination.longitude}|$vehicleClass';

    // Cancel any previous in-flight request for a *different* destination so
    // we never render a stale route or race old responses over new ones.
    for (final entry in _inflight.entries.toList()) {
      if (entry.key != key) {
        entry.value.cancel();
        _inflight.remove(entry.key);
        _dedupe.remove(entry.key);
      }
    }

    if (_dedupe.containsKey(key)) return _dedupe[key]!;

    final token = CancelToken();
    _inflight[key] = token;

    final future = _fetch(origin, destination, vehicleClass, token).whenComplete(() {
      _inflight.remove(key);
      _dedupe.remove(key);
    });

    _dedupe[key] = future;
    return future;
  }

  Future<TripPlan> _fetch(
    LatLng origin,
    LatLng destination,
    String vehicleClass,
    CancelToken token,
  ) async {
    try {
      final response = await (_testPost ??
          (path, {required data, cancelToken, options}) =>
              _dio.post(path, data: data, cancelToken: cancelToken, options: options))(
        '$_baseUrl/api/routing/plan',
        data: {
          'origin': [origin.latitude, origin.longitude],
          'destination': [destination.latitude, destination.longitude],
          'vehicleClass': vehicleClass,
        },
        cancelToken: token,
        options: Options(
          sendTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 10),
        ),
      );

      if (response.statusCode == 200 && response.data != null) {
        final data = response.data as Map<String, dynamic>;
        final geometry = data['geometry'];

        final stopwatch = Stopwatch()..start();
        final points = _flattenGeometry(geometry);
        final decodeMicros = stopwatch.elapsedMicroseconds;

        final fare = data['fare'] as Map<String, dynamic>? ?? {};

        return TripPlan(
          points: points,
          distanceMeters: (data['distanceMeters'] as num?)?.toDouble() ?? 0.0,
          durationSeconds: (data['durationSeconds'] as num?)?.toDouble() ?? 0.0,
          etaSeconds: (data['etaSeconds'] as num?)?.toDouble() ?? 0.0,
          fare: fare,
          engine: data['engine']?.toString() ?? 'Backend',
          cacheHit: data['cacheHit'] as bool? ?? false,
          decodeMicros: decodeMicros,
        );
      }
    } on DioException catch (e) {
      if (e.type == DioExceptionType.cancel) {
        // Silent — superseded by a newer request.
        rethrow;
      }
      debugPrint('[ROUTING] Backend call failed: $e');
    } catch (e) {
      debugPrint('[ROUTING] Unexpected error: $e');
    }

    // High-quality local fallback keeps the UI responsive offline.
    return _calculateLocalPremiumFallback(origin, destination);
  }

  /// Flatten a GeoJSON LineString geometry into LatLng points that follow
  /// the real road geometry returned by the backend.
  List<LatLng> _flattenGeometry(dynamic geometry) {
    final List<LatLng> out = [];

    void addLine(List coords) {
      for (final c in coords) {
        if (c is List && c.length >= 2) {
          // GeoJSON coordinates are [lng, lat].
          out.add(LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble()));
        }
      }
    }

    if (geometry is Map) {
      final type = geometry['type'];
      if (type == 'LineString') {
        addLine(geometry['coordinates'] as List);
      } else if (type == 'MultiLineString') {
        for (final line in (geometry['coordinates'] as List)) {
          addLine(line as List);
        }
      }
    }
    return out;
  }

  TripPlan _calculateLocalPremiumFallback(LatLng start, LatLng end) {
    const double urbanSpeedMps = 5.5; // ~20 km/h
    const double detourFactor = 1.4;

    final directDistance = const Distance().as(LengthUnit.Meter, start, end);
    final streetDist = directDistance * detourFactor;
    final durationSeconds = streetDist / urbanSpeedMps;

    // Road-shaped (Manhattan-style) fallback path — two bends through a
    // midpoint corner so it reads as city-grid travel, never a straight line.
    final midLat = (start.latitude + end.latitude) / 2;
    final midLng = (start.longitude + end.longitude) / 2;
    final points = [
      start,
      LatLng(midLat, start.longitude),
      LatLng(midLat, midLng),
      LatLng(end.latitude, midLng),
      end,
    ];

    return TripPlan(
      points: points,
      distanceMeters: streetDist,
      durationSeconds: durationSeconds,
      etaSeconds: durationSeconds * 1.2,
      // Compute a local fare so the rider never sees $0 while offline.
      fare: _localFare(streetDist, durationSeconds),
      engine: 'Local-Premium-Fallback',
      cacheHit: false,
      decodeMicros: 0,
    );
  }

  /// Mirror of the backend in-memory fare formula so the offline fallback
  /// still shows a realistic, non-zero price.
  Map<String, dynamic> _localFare(double distanceMeters, double durationSeconds) {
    const base = 3.50;
    const perKm = 1.50;
    const perMin = 0.35;
    const booking = 1.50;
    final distanceKm = distanceMeters / 1000;
    final minutes = durationSeconds / 60;
    final subtotal = base + distanceKm * perKm + minutes * perMin + booking;
    final service = subtotal * 0.10;
    final taxes = (subtotal + service) * 0.0875;
    final total = (subtotal + service + taxes);
    return {
      'baseFare': base,
      'distanceFare': distanceKm * perKm,
      'timeFare': minutes * perMin,
      'bookingFee': booking,
      'surgeMultiplier': 1.0,
      'serviceFee': service,
      'taxes': taxes,
      'totalFare': double.parse(total.toStringAsFixed(2)),
      'currency': 'USD',
    };
  }
}
