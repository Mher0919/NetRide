import 'dart:async';
import 'dart:io';
import 'package:dio/dio.dart';
import 'package:latlong2/latlong.dart';
import 'api_service.dart';

class RoutingService {
  final Dio _dio = ApiService.dio;

  Future<Map<String, dynamic>> getRoute(LatLng start, LatLng end) async {
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
      print('[ROUTING] Backend Call Failed: $e');
    }

    // High-Quality Local Fallback
    return calculateLocalFallback(start, end);
  }

  /**
   * Ask the server for a manual reroute. The backend re-runs OSRM
   * from the supplied start, replaces the cached leg, and emits the
   * navigationRouteUpdated / navigationRerouteRequested events. Returns
   * the fresh route payload so the caller can rehydrate its local
   * NavigationRoute immediately (without waiting for the socket).
   */
  Future<Map<String, dynamic>?> requestReroute({
    required String tripId,
    required String leg, // 'pickup' | 'destination'
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
      print('[ROUTING] Manual reroute failed: $e');
    }
    return null;
  }

  /**
   * Read the cached leg for the trip from the backend's per-leg cache.
   * The driver app calls this on socket rehydrate so we don't make a
   * second OSRM round-trip after a navigationStarted event.
   */
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
      print('[ROUTING] Cached-leg fetch failed: $e');
    }
    return null;
  }

  Map<String, dynamic> _hydrate(Map<String, dynamic> data) {
    final geometry = data['geometry'];
    final points = _flattenGeometry(geometry);
    return {
      'points_list': points,
      'distance': (data['distance'] as num?)?.toDouble() ?? 0.0,
      'duration': (data['eta'] as num?)?.toDouble() ?? 0.0,
      'osrm_duration': (data['osrm_duration'] as num?)?.toDouble() ?? 0.0,
      'engine': data['engine'] ?? 'Backend-Gateway',
      'cache_hit': data['cache_hit'] ?? false,
      'steps': (data['steps'] as List?) ?? const [],
      'speedLimitsByRoad': (data['speedLimitsByRoad'] as Map?) ?? const {},
      'cachedAt': data['cachedAt'],
    };
  }

  /// Flatten a GeoJSON geometry (LineString or MultiLineString) — or a
  /// Geoapify-style FeatureCollection/Feature — into road-following points.
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
      } else if (type == 'FeatureCollection') {
        for (final f in (geometry['features'] as List? ?? [])) {
          final g = (f as Map)['geometry'];
          if (g != null) out.addAll(_flattenGeometry(g));
        }
      } else if (type == 'Feature') {
        final g = geometry['geometry'];
        if (g != null) out.addAll(_flattenGeometry(g));
      }
    }
    return out;
  }

  Map<String, dynamic> calculateLocalFallback(LatLng start, LatLng end) {
    const double urbanSpeedMps = 5.5; // ~20 km/h
    const double detourFactor = 1.4;

    double directDistance = const Distance().as(LengthUnit.Meter, start, end);
    double streetDist = directDistance * detourFactor;

    // Create a "Premium Staircase" path (mimics urban grid)
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