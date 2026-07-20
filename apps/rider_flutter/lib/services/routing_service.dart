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

  // API Gateway URL.
  final String _baseUrl =
      Platform.isAndroid ? 'http://10.0.2.2:3000' : 'http://127.0.0.1:3000';

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
      final response = await _dio.post(
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

    // L-shaped (road-shaped, NOT straight) fallback path.
    final points = [
      start,
      LatLng(start.latitude, end.longitude),
      end,
    ];

    return TripPlan(
      points: points,
      distanceMeters: streetDist,
      durationSeconds: streetDist / urbanSpeedMps,
      etaSeconds: (streetDist / urbanSpeedMps) * 1.2,
      fare: {},
      engine: 'Local-Premium-Fallback',
      cacheHit: false,
      decodeMicros: 0,
    );
  }
}
