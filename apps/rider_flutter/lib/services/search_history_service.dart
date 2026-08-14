import 'package:flutter/foundation.dart';
import 'package:latlong2/latlong.dart';
import '../models/search_result.dart';
import '../services/api_service.dart';
import '../utils/spatial_hash.dart';

class HistoryRouteInfo {
  final double distanceMeters;
  final double durationSeconds;
  final double? trafficDurationSeconds;

  const HistoryRouteInfo({
    required this.distanceMeters,
    required this.durationSeconds,
    this.trafficDurationSeconds,
  });

  Map<String, dynamic> toJson() => {
    'distanceMeters': distanceMeters,
    'durationSeconds': durationSeconds,
    'trafficDurationSeconds': trafficDurationSeconds,
  };

  factory HistoryRouteInfo.fromJson(Map<String, dynamic> json) =>
      HistoryRouteInfo(
        distanceMeters: (json['distanceMeters'] as num).toDouble(),
        durationSeconds: (json['durationSeconds'] as num).toDouble(),
        trafficDurationSeconds: (json['trafficDurationSeconds'] as num?)
            ?.toDouble(),
      );
}

class CachedRoute {
  final double originLat;
  final double originLon;
  final double destLat;
  final double destLon;
  final String originName;
  final String destName;
  final double distanceMeters;
  final double durationSeconds;
  final double? trafficDurationSeconds;
  final List<LatLng> polyline;
  final String vehicleClass;
  final DateTime savedAt;

  const CachedRoute({
    required this.originLat,
    required this.originLon,
    required this.destLat,
    required this.destLon,
    required this.originName,
    required this.destName,
    required this.distanceMeters,
    required this.durationSeconds,
    this.trafficDurationSeconds,
    required this.polyline,
    required this.vehicleClass,
    required this.savedAt,
  });

  Map<String, dynamic> toJson() => {
    'originLat': originLat,
    'originLon': originLon,
    'destLat': destLat,
    'destLon': destLon,
    'originName': originName,
    'destName': destName,
    'distanceMeters': distanceMeters,
    'durationSeconds': durationSeconds,
    'trafficDurationSeconds': trafficDurationSeconds,
    'polyline': polyline.map((p) => [p.latitude, p.longitude]).toList(),
    'vehicleClass': vehicleClass,
  };

  factory CachedRoute.fromJson(Map<String, dynamic> json) => CachedRoute(
    originLat: (json['originLat'] as num).toDouble(),
    originLon: (json['originLon'] as num).toDouble(),
    destLat: (json['destLat'] as num).toDouble(),
    destLon: (json['destLon'] as num).toDouble(),
    originName: json['originName'] as String,
    destName: json['destName'] as String,
    distanceMeters: (json['distanceMeters'] as num).toDouble(),
    durationSeconds: (json['durationSeconds'] as num).toDouble(),
    trafficDurationSeconds: (json['trafficDurationSeconds'] as num?)
        ?.toDouble(),
    polyline: (json['polyline'] as List)
        .map((c) => LatLng((c[0] as num).toDouble(), (c[1] as num).toDouble()))
        .toList(),
    vehicleClass: json['vehicleClass'] as String,
    savedAt: DateTime.fromMillisecondsSinceEpoch(json['savedAt'] as int),
  );
}

class SearchHistoryService {
  static final SearchHistoryService instance = SearchHistoryService._();
  SearchHistoryService._();

  Future<List<SearchResult>> fetch() async {
    try {
      final response = await ApiService.dio.get('user/search-history');
      if (response.data is! List) return [];
      return (response.data as List)
          .map((j) => SearchResult.fromJson(j as Map<String, dynamic>))
          .where((r) => r.hasValidCoordinates)
          .toList();
    } catch (e) {
      // Never crash the map for a history fetch — but log it so an EMPTY
      // recent list is diagnosable (unreachable backend vs truly empty).
      debugPrint('[SEARCH_HISTORY] fetch failed (returning empty): $e');
      return [];
    }
  }

  Future<void> save(SearchResult result, {HistoryRouteInfo? routeInfo}) async {
    try {
      final data = <String, dynamic>{
        'displayName': result.displayName,
        'lat': result.lat,
        'lon': result.lon,
        'state': result.state,
        'type': result.type,
        if (result.distanceMiles != null) 'distance': result.distanceMiles,
        if (result.formattedAddress != null)
          'formatted_address': result.formattedAddress,
        if (result.street != null) 'street': result.street,
        if (result.city != null) 'city': result.city,
        if (result.zip != null) 'zip': result.zip,
        if (result.category != null) 'category': result.category,
        if (result.subcategory != null) 'subcategory': result.subcategory,
        if (routeInfo != null) 'route_info': routeInfo.toJson(),
      };
      final originHash = SpatialHash.encode(result.lat, result.lon);
      data['origin_geohash'] = originHash;

      await ApiService.dio.post('user/search-history', data: data);
    } catch (_) {}
  }

  Future<void> clear() async {
    try {
      await ApiService.dio.delete('user/search-history');
    } catch (_) {}
  }

  Future<List<CachedRoute>> fetchRecentRoutes() async {
    try {
      final response = await ApiService.dio.get('user/search-history/routes');
      if (response.data is! List) return [];
      return (response.data as List)
          .cast<Map<String, dynamic>>()
          .map((j) => CachedRoute.fromJson(j))
          .toList();
    } catch (e) {
      debugPrint('[SEARCH_HISTORY] fetchRecentRoutes failed (returning empty): $e');
      return [];
    }
  }

  Future<void> saveRoute(CachedRoute route) async {
    try {
      await ApiService.dio.post(
        'user/search-history/routes',
        data: route.toJson(),
      );
    } catch (_) {}
  }
}
