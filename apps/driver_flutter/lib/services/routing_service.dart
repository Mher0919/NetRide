import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:latlong2/latlong.dart';
import 'api_service.dart';
import 'google_routes_service.dart';
import '../models/route_models.dart';

class RoutingService {
  final Dio _dio = ApiService.dio;
  final GoogleRoutesService _googleRoutes = GoogleRoutesService();

  Future<Map<String, dynamic>> getRoute(LatLng start, LatLng end) async {
    try {
      final routeResponse = await _googleRoutes.getRoute(
        origin: start,
        destination: end,
      );

      return _hydrateFromRoute(routeResponse);
    } catch (e) {
      debugPrint('[ROUTING] Google Routes failed: $e');
    }

    try {
      final response = await _dio.post(
        '/geospatial/route',
        data: {
          'start': [start.latitude, start.longitude],
          'end': [end.latitude, end.longitude],
        },
        options: Options(
          sendTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 10),
        ),
      );

      if (response.statusCode == 200) {
        final data = response.data;
        if (data != null && data['geometry'] != null) {
          final geometry = data['geometry'];
          List<LatLng> points = [];

          if (geometry['type'] == 'LineString' && geometry['coordinates'] != null) {
            final coords = geometry['coordinates'] as List;
            points = coords.map((c) => LatLng(c[1] as double, c[0] as double)).toList();
          }

          return _hydrate({
            ...data,
            'points_list': points,
          });
        }
      }
    } catch (e) {
      debugPrint('[ROUTING] Backend Call Failed: $e');
    }

    return calculateLocalFallback(start, end);
  }

  Future<Map<String, dynamic>?> requestReroute({
    required String tripId,
    required String leg,
    required LatLng from,
  }) async {
    try {
      final response = await _dio.post(
        '/navigation/reroute',
        data: {
          'tripId': tripId,
          'leg': leg,
          'lat': from.latitude,
          'lng': from.longitude,
        },
        options: Options(
          sendTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 10),
        ),
      );
      if (response.statusCode == 200 && response.data is Map) {
        final body = response.data as Map<String, dynamic>;
        final route = body['route'] as Map<String, dynamic>?;
        if (route != null) return _hydrate(route);
      }
    } catch (e) {
      debugPrint('[ROUTING] Manual reroute failed: $e');
    }
    return null;
  }

  Future<Map<String, dynamic>?> getCachedLeg({
    required String tripId,
    required String leg,
  }) async {
    try {
      final response = await _dio.get(
        '/navigation/cached',
        queryParameters: {'tripId': tripId, 'leg': leg},
        options: Options(
          sendTimeout: const Duration(seconds: 5),
          receiveTimeout: const Duration(seconds: 5),
        ),
      );
      if (response.statusCode == 200 && response.data is Map) {
        final m = response.data as Map<String, dynamic>;
        if (m['route'] == null) return null;
        return _hydrate(m['route'] as Map<String, dynamic>);
      }
    } catch (e) {
      debugPrint('[ROUTING] Cached-leg fetch failed: $e');
    }
    return null;
  }

  Map<String, dynamic> _hydrate(Map<String, dynamic> data) {
    return {
      'points_list': data['points_list'] ?? data['polyline'] ?? <LatLng>[],
      'distance': (data['distance'] as num?)?.toDouble() ?? 0.0,
      'duration': (data['duration'] as num?)?.toDouble() ?? (data['eta'] as num?)?.toDouble() ?? 0.0,
      'osrm_duration': (data['osrm_duration'] as num?)?.toDouble() ?? 0.0,
      'engine': data['engine'] ?? 'GoogleRoutes',
      'cache_hit': data['cacheHit'] as bool? ?? data['cache_hit'] as bool? ?? false,
      'steps': (data['steps'] as List?) ?? const [],
      'speedLimitsByRoad': (data['speedLimitsByRoad'] as Map?) ?? const {},
      'cachedAt': data['cachedAt'],
    };
  }

  Map<String, dynamic> _hydrateFromRoute(RouteResponse route) {
    return {
      'points_list': route.polyline,
      'distance': route.distanceMeters,
      'duration': route.durationSeconds,
      'eta': route.trafficDurationSeconds ?? route.durationSeconds,
      'engine': route.engine,
      'cache_hit': route.cacheHit,
      'steps': route.steps.map((s) => s.toJson()).toList(),
      'speedLimitsByRoad': <String, int>{},
      'cachedAt': DateTime.now().toIso8601String(),
    };
  }

  Map<String, dynamic> calculateLocalFallback(LatLng start, LatLng end) {
    const double urbanSpeedMps = 5.5;
    const double detourFactor = 1.4;

    double directDistance = const Distance().as(LengthUnit.Meter, start, end);
    double streetDist = directDistance * detourFactor;

    List<LatLng> points = [
      start,
      LatLng(start.latitude, end.longitude),
      end,
    ];

    return {
      'points_list': points,
      'distance': streetDist,
      'duration': streetDist / urbanSpeedMps,
      'engine': 'Local-Premium-Fallback',
      'steps': const [],
      'speedLimitsByRoad': const {},
    };
  }
}
