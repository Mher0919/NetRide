import 'dart:async';
import 'dart:io';
import 'package:dio/dio.dart';
import 'package:latlong2/latlong.dart';

class RoutingService {
  final Dio _dio = Dio();
  
  // API Gateway URL
  final String _baseUrl = Platform.isAndroid ? 'http://10.0.2.2:3000' : 'http://127.0.0.1:3000';

  Future<Map<String, dynamic>> getRoute(LatLng start, LatLng end) async {
    try {
      // Call Backend API Gateway (which handles Cache, OSRM, and ML ETA)
      final response = await _dio.post(
        '$_baseUrl/api/geospatial/route',
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
          List<LatLng> points = _flattenGeometry(geometry);

          return {
            'points_list': points,
            'distance': (data['distance'] as num?)?.toDouble() ?? 0.0,
            'duration': (data['eta'] as num?)?.toDouble() ?? 0.0,
            'osrm_duration': (data['osrm_duration'] as num?)?.toDouble() ?? 0.0,
            'engine': data['engine'] ?? 'Backend-Gateway',
            'cache_hit': data['cache_hit'] ?? false,
          };
        }
      }
    } catch (e) {
      print('[ROUTING] Backend Call Failed: $e');
    }

    // High-Quality Local Fallback
    return _calculateLocalPremiumFallback(start, end);
  }

  /// Flatten a GeoJSON geometry (LineString or MultiLineString) — or a
  /// Geoapify-style FeatureCollection/Feature — into a single list of LatLng
  /// points following the actual road geometry.
  List<LatLng> _flattenGeometry(dynamic geometry) {
    List<LatLng> out = [];

    void addLine(List coords) {
      for (final c in coords) {
        if (c is List && c.length >= 2) {
          // GeoJSON coordinates are [lng, lat]
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
        final features = geometry['features'] as List? ?? [];
        for (final f in features) {
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

  Map<String, dynamic> _calculateLocalPremiumFallback(LatLng start, LatLng end) {
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
    };
  }
}
