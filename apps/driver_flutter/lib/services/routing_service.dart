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
      'points_list': _extractPoints(data),
      'distance': (data['distance'] as num?)?.toDouble() ?? 0.0,
      'duration': (data['duration'] as num?)?.toDouble() ?? (data['osrm_duration'] as num?)?.toDouble() ?? (data['eta'] as num?)?.toDouble() ?? 0.0,
      'osrm_duration': (data['osrm_duration'] as num?)?.toDouble() ?? 0.0,
      'eta': (data['eta'] as num?)?.toDouble() ?? 0.0,
      'engine': data['engine'] ?? 'GoogleRoutes',
      'cache_hit': data['cacheHit'] as bool? ?? data['cache_hit'] as bool? ?? false,
      'steps': (data['steps'] as List?) ?? const [],
      'speedLimitsByRoad': (data['speedLimitsByRoad'] as Map?) ?? const {},
      'trafficDurationSeconds': (data['trafficDurationSeconds'] as num?)?.toDouble(),
      'cachedAt': data['cachedAt'],
    };
  }

  /// Normalize every route payload shape the backend produces into a
  /// flat list of [lng, lat] coordinate pairs:
  ///   - `points_list`: List<LatLng> (legacy local hydration)
  ///   - `polyline`:    [[lng, lat], ...] (google-plan / reroute wire)
  ///   - `geometry`:    GeoJSON LineString {coordinates: [[lng, lat]]}
  ///   - `encodedPolyline`: string (Google polyline6)
  List<List<double>> _extractPoints(Map<String, dynamic> data) {
    final raw = data['points_list'] ?? data['polyline'];
    if (raw is List && raw.isNotEmpty) {
      final first = raw.first;
      if (first is LatLng) {
        return raw
            .whereType<LatLng>()
            .map((p) => <double>[p.longitude, p.latitude])
            .toList();
      }
      final out = <List<double>>[];
      for (final c in raw) {
        if (c is List && c.length >= 2 && c[0] is num && c[1] is num) {
          out.add([(c[0] as num).toDouble(), (c[1] as num).toDouble()]);
        }
      }
      if (out.isNotEmpty) return out;
    }

    final geometry = data['geometry'];
    if (geometry is Map && geometry['type'] == 'LineString') {
      final coords = geometry['coordinates'] as List? ?? [];
      final out = <List<double>>[];
      for (final c in coords) {
        if (c is List && c.length >= 2 && c[0] is num && c[1] is num) {
          out.add([(c[0] as num).toDouble(), (c[1] as num).toDouble()]);
        }
      }
      if (out.isNotEmpty) return out;
    }

    final encoded = data['encodedPolyline'];
    if (encoded is String && encoded.isNotEmpty) {
      return decodeEncodedPolyline(encoded);
    }

    return const [];
  }

  /// Google polyline6 decoder -> [[lng, lat], ...].
  List<List<double>> decodeEncodedPolyline(String encoded) {
    final out = <List<double>>[];
    int index = 0;
    final len = encoded.length;
    int lat = 0;
    int lng = 0;
    while (index < len) {
      int b;
      int shift = 0;
      int result = 0;
      do {
        b = encoded.codeUnitAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      final dlat = (result & 1) != 0 ? ~(result >> 1) : result >> 1;
      lat += dlat;
      shift = 0;
      result = 0;
      do {
        b = encoded.codeUnitAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      final dlng = (result & 1) != 0 ? ~(result >> 1) : result >> 1;
      lng += dlng;
      out.add([lng / 1e5, lat / 1e5]);
    }
    return out;
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
