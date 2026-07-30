import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:latlong2/latlong.dart';
import 'api_service.dart';
import '../models/route_models.dart';
import '../utils/spatial_hash.dart';
import 'route_cache_service.dart';
import 'eta_cache_service.dart';

class GoogleRoutesService {
  final Dio _dio = ApiService.dio;
  final RouteCacheService _routeCache = RouteCacheService.instance;
  final EtaCacheService _etaCache = EtaCacheService.instance;

  final Map<String, CancelToken> _inflight = {};
  final Map<String, Future<RouteResponse>> _dedupe = {};

  Future<RouteResponse> getRoute({
    required LatLng origin,
    required LatLng destination,
    bool forceRefresh = false,
  }) async {
    final key = '${origin.latitude},${origin.longitude}|${destination.latitude},${destination.longitude}';

    if (!forceRefresh) {
      final cached = _routeCache.get(
        originLat: origin.latitude,
        originLng: origin.longitude,
        destLat: destination.latitude,
        destLng: destination.longitude,
      );
      if (cached != null) {
        debugPrint('[GAPI] Route cache HIT for $key');
        return cached;
      }
    }

    if (_dedupe.containsKey(key)) {
      debugPrint('[GAPI] Dedupe HIT for $key');
      return _dedupe[key]!;
    }

    for (final entry in _inflight.entries.toList()) {
      if (entry.key != key) {
        entry.value.cancel();
        _inflight.remove(entry.key);
        _dedupe.remove(entry.key);
      }
    }

    final token = CancelToken();
    _inflight[key] = token;

    final future = _fetch(origin, destination, token).whenComplete(() {
      _inflight.remove(key);
      _dedupe.remove(key);
    });

    _dedupe[key] = future;
    return future;
  }

  Future<RouteSummary?> getEta({
    required LatLng origin,
    required LatLng destination,
  }) async {
    final cached = _etaCache.get(
      originLat: origin.latitude,
      originLng: origin.longitude,
      destLat: destination.latitude,
      destLng: destination.longitude,
    );
    if (cached != null) return cached;

    try {
      final route = await getRoute(origin: origin, destination: destination);
      final summary = RouteSummary(
        originHex: route.originHex,
        destHex: route.destHex,
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        trafficDurationSeconds: route.trafficDurationSeconds,
        cachedAt: DateTime.now(),
      );
      _etaCache.set(summary);
      return summary;
    } catch (e) {
      debugPrint('[GAPI] ETA fetch failed: $e');
      return null;
    }
  }

  Future<RouteResponse> _fetch(
    LatLng origin,
    LatLng destination,
    CancelToken token,
  ) async {
    final originHash = SpatialHash.originKey(origin.latitude, origin.longitude);
    final destHash = SpatialHash.destKey(destination.latitude, destination.longitude);

    try {
      final response = await _dio.post(
        '/routing/google-plan',
        data: {
          'origin': [origin.latitude, origin.longitude],
          'destination': [destination.latitude, destination.longitude],
          'originHex': originHash,
          'destHex': destHash,
        },
        cancelToken: token,
        options: Options(
          sendTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 10),
        ),
      );

      if (response.statusCode == 200 && response.data != null) {
        final data = response.data as Map<String, dynamic>;
        final route = RouteResponse.fromJson(data);

        _routeCache.set(route);

        _etaCache.set(RouteSummary(
          originHex: originHash,
          destHex: destHash,
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
          trafficDurationSeconds: route.trafficDurationSeconds,
          cachedAt: DateTime.now(),
        ));

        return route;
      }
    } on DioException catch (e) {
      if (e.type == DioExceptionType.cancel) rethrow;
      debugPrint('[GAPI] Backend call failed: $e');
    } catch (e) {
      debugPrint('[GAPI] Unexpected error: $e');
    }

    return _localFallback(origin, destination, originHash, destHash);
  }

  RouteResponse _localFallback(LatLng origin, LatLng destination, String originHash, String destHash) {
    const double urbanSpeedMps = 5.5;
    const double detourFactor = 1.4;

    final directDistance = const Distance().as(LengthUnit.Meter, origin, destination);
    final streetDist = directDistance * detourFactor;
    final durationSeconds = streetDist / urbanSpeedMps;

    final midLat = (origin.latitude + destination.latitude) / 2;
    final midLng = (origin.longitude + destination.longitude) / 2;

    final polyline = [
      origin,
      LatLng(midLat, origin.longitude),
      LatLng(midLat, midLng),
      LatLng(destination.latitude, midLng),
      destination,
    ];

    return RouteResponse(
      originHex: originHash,
      destHex: destHash,
      distanceMeters: streetDist,
      durationSeconds: durationSeconds,
      trafficDurationSeconds: durationSeconds * 1.2,
      polyline: polyline,
      steps: const [],
      engine: 'Local-Fallback',
      cacheHit: false,
    );
  }
}
