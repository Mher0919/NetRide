// lib/services/heatmap_service.dart
//
// Client for the demand heatmap API (GET /api/heatmap, driver-only route).
// The backend answers from a 45-second Redis cache; the availability screen
// polls on that cadence while the driver is online and idle.

import 'package:dio/dio.dart';
import '../models/demand_zone.dart';
import 'api_service.dart';

class HeatmapService {
  HeatmapService._();

  /// How long the backend cache lives — never poll faster than this.
  static const Duration cacheTtl = Duration(seconds: 45);

  static Future<DemandQuery> fetchZones({
    required double lat,
    required double lng,
    double radiusKm = 10,
  }) async {
    final response = await ApiService.dio.get(
      '/heatmap',
      queryParameters: {'lat': lat, 'lng': lng, 'radiusKm': radiusKm},
    );
    return DemandQuery.fromJson(
      Map<String, dynamic>.from(response.data as Map),
    );
  }

  static String friendlyError(DioException e) {
    if (e.response?.statusCode == 401) return 'Please sign in again.';
    if (e.type == DioExceptionType.connectionTimeout ||
        e.type == DioExceptionType.receiveTimeout) {
      return 'Demand data is taking too long — retrying shortly.';
    }
    return 'Demand data unavailable.';
  }
}