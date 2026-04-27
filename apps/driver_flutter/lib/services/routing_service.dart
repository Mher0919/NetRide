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
          List<LatLng> points = [];

          if (geometry['type'] == 'LineString' && geometry['coordinates'] != null) {
            final coords = geometry['coordinates'] as List;
            points = coords.map((c) => LatLng(c[1] as double, c[0] as double)).toList();
          }

          return {
            'points_list': points,
            'distance': (data['distance'] as num).toDouble(),
            'duration': (data['eta'] as num).toDouble(), // Use ML-corrected ETA
            'osrm_duration': (data['osrm_duration'] as num).toDouble(),
            'engine': data['engine'] ?? 'Backend-Gateway',
            'cache_hit': data['cache_hit'] ?? false,
          };
        }
      }
    } catch (e) {
      print('[ROUTING] Backend Call Failed: $e');
    }

    // High-Quality Local Fallback
    return calculateLocalFallback(start, end);
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
    };
  }
}
