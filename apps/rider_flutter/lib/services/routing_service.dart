import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:latlong2/latlong.dart';
import 'api_service.dart';
import 'route_cache_service.dart';

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
    this.trafficDurationSeconds,
  });

  final List<LatLng> points;
  final double distanceMeters;
  final double durationSeconds;
  final double etaSeconds;
  final double? trafficDurationSeconds;
  final Map<String, dynamic> fare;
  final String engine;
  final bool cacheHit;
  final int decodeMicros;
}

class RoutingService {
  final Dio _dio = ApiService.dio;
  final RouteCacheService _routeCache = RouteCacheService.instance;

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

  final Map<String, CancelToken> _inflight = {};
  final Map<String, Future<TripPlan>> _dedupe = {};

  Future<TripPlan> plan({
    required LatLng origin,
    required LatLng destination,
    bool bypassCache = false,
  }) async {
    final key =
        '${origin.latitude},${origin.longitude}|${destination.latitude},${destination.longitude}';

    if (!bypassCache && _dedupe.containsKey(key)) return _dedupe[key]!;

    for (final entry in _inflight.entries.toList()) {
      if (entry.key != key) {
        entry.value.cancel();
        _inflight.remove(entry.key);
        _dedupe.remove(entry.key);
      }
    }

    if (!bypassCache) {
      final cached = _routeCache.get(
        originLat: origin.latitude,
        originLng: origin.longitude,
        destLat: destination.latitude,
        destLng: destination.longitude,
      );
      if (cached != null) {
        // Serve instantly — NEVER block the UI on a stale cache. When the
        // cached plan lacks a backend fare (pre-fix entry), refresh it in
        // the background so the price appears on the very next tick.
        if (cached.needsFareRefresh) {
          _refreshFareInBackground(origin, destination, key);
        }
        return _hydrateCached(cached, origin, destination, 'RouteCache');
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

  /// Background refetch of a fare-less cached route. Fire-and-forget: the
  /// cached plan keeps serving the UI; the fresh (priced) plan overwrites
  /// the cache when it lands. Skipped in tests and when a live fetch is
  /// already in flight for the same route (that one will refresh it).
  void _refreshFareInBackground(LatLng origin, LatLng destination, String key) {
    if (_testPost != null) return; // unit tests: no background traffic
    if (_inflight.containsKey(key)) return; // a live fetch will refresh it
    debugPrint('[ROUTING] Cached plan has no fare — refreshing in background');
    Future<void>(() async {
      try {
        await _fetch(origin, destination, CancelToken());
      } catch (e) {
        // Non-fatal: the old cache entry keeps serving until TTL.
        if (e is! DioException || e.type != DioExceptionType.cancel) {
          debugPrint('[ROUTING] Background fare refresh failed (kept cache): $e');
        }
      }
    });
  }

  Future<TripPlan> _fetch(
    LatLng origin,
    LatLng destination,
    CancelToken token,
  ) async {
    try {
      final response = await (_testPost ??
          (path, {required data, cancelToken, options}) =>
              _dio.post(path, data: data, cancelToken: cancelToken, options: options))(
        '/routing/google-plan',
        data: {
          'origin': [origin.latitude, origin.longitude],
          'destination': [destination.latitude, destination.longitude],
        },
        cancelToken: token,
        options: Options(
          sendTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 10),
        ),
      );

      if (response.statusCode == 200 && response.data != null) {
        final data = response.data as Map<String, dynamic>;
        final polyline = data['polyline'];
        debugPrint('[ROUTING] google-plan response: polyline type=${polyline.runtimeType}, length=${polyline is List ? polyline.length : 'N/A'}, engine=${data['engine']}, cacheHit=${data['cacheHit']}, distanceMeters=${data['distanceMeters']}');
        final points = _parsePolyline(polyline);
        debugPrint('[ROUTING] Parsed points: ${points.length}');

        final distanceMeters = (data['distanceMeters'] as num?)?.toDouble() ?? 0;
        final durationSeconds = (data['durationSeconds'] as num?)?.toDouble() ?? 0;
        // Backend-computed fare is the single source of truth. An empty map
        // (missing field) means "no price available" — never derived locally.
        final fare = data['fare'] as Map<String, dynamic>? ??
            const <String, dynamic>{};

        final plan = TripPlan(
          points: points,
          distanceMeters: distanceMeters,
          durationSeconds: durationSeconds,
          etaSeconds: (data['etaSeconds'] as num?)?.toDouble() ?? 0,
          trafficDurationSeconds: (data['trafficDurationSeconds'] as num?)?.toDouble(),
          fare: fare,
          engine: data['engine']?.toString() ?? 'GoogleRoutes',
          cacheHit: data['cacheHit'] as bool? ?? false,
          decodeMicros: 0,
        );

        _routeCache.set(
          originLat: origin.latitude,
          originLng: origin.longitude,
          destLat: destination.latitude,
          destLng: destination.longitude,
          distanceMeters: plan.distanceMeters,
          durationSeconds: plan.durationSeconds,
          trafficDurationSeconds: plan.trafficDurationSeconds,
          polyline: points,
        );

        return plan;
      }
    } on DioException catch (e) {
      if (e.type == DioExceptionType.cancel) rethrow;
      debugPrint('[ROUTING] Google-plan failed: $e');
      // Don't fall through - return fallback
    } catch (e) {
      debugPrint('[ROUTING] Google-plan unexpected error: $e');
      // Don't fall through - return fallback
    }

    debugPrint('[ROUTING] Falling back to /routing/plan');
    try {
      final response = await (_testPost ??
          (path, {required data, cancelToken, options}) =>
              _dio.post(path, data: data, cancelToken: cancelToken, options: options))(
        '/routing/plan',
        data: {
          'origin': [origin.latitude, origin.longitude],
          'destination': [destination.latitude, destination.longitude],
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
          distanceMeters: (data['distanceMeters'] as num?)?.toDouble() ?? 0,
          durationSeconds: (data['durationSeconds'] as num?)?.toDouble() ?? 0,
          etaSeconds: (data['etaSeconds'] as num?)?.toDouble() ?? 0,
          fare: fare,
          engine: data['engine']?.toString() ?? 'Backend',
          cacheHit: data['cacheHit'] as bool? ?? false,
          decodeMicros: decodeMicros,
        );
      }
    } on DioException catch (e) {
      if (e.type == DioExceptionType.cancel) rethrow;
      debugPrint('[ROUTING] Backend plan failed: $e');
    } catch (e) {
      debugPrint('[ROUTING] Unexpected error: $e');
    }

    return _calculateLocalPremiumFallback(origin, destination);
  }

  List<LatLng> _parsePolyline(dynamic polyline) {
    if (polyline is List) {
      return polyline.map((c) {
        if (c is List && c.length >= 2) {
          return LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble());
        }
        return null;
      }).whereType<LatLng>().toList();
    }
    return [];
  }

  List<LatLng> _flattenGeometry(dynamic geometry) {
    final List<LatLng> out = [];

    void addLine(List coords) {
      for (final c in coords) {
        if (c is List && c.length >= 2) {
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

  TripPlan _hydrateCached(CachedRouteData cached, LatLng origin, LatLng destination, String source) {
    return TripPlan(
      points: cached.polyline ?? [origin, destination],
      distanceMeters: cached.distanceMeters,
      durationSeconds: cached.durationSeconds,
      etaSeconds: cached.trafficDurationSeconds ?? cached.durationSeconds,
      trafficDurationSeconds: cached.trafficDurationSeconds,
      // Cached plans never serve a price — fares are backend-authoritative
      // and change on admin pricing edits. The cache-hit path always kicks a
      // background refresh that lands the fresh backend fare on the next
      // render; until then no price is shown.
      fare: const <String, dynamic>{},
      engine: source,
      cacheHit: true,
      decodeMicros: 0,
    );
  }

  TripPlan _calculateLocalPremiumFallback(LatLng start, LatLng end) {
    const double urbanSpeedMps = 5.5;
    const double detourFactor = 1.4;

    final directDistance = const Distance().as(LengthUnit.Meter, start, end);
    final streetDist = directDistance * detourFactor;
    final durationSeconds = streetDist / urbanSpeedMps;

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
      // Offline fallback has no backend fare — never derived locally.
      fare: const <String, dynamic>{},
      engine: 'Local-Premium-Fallback',
      cacheHit: false,
      decodeMicros: 0,
    );
  }
}
