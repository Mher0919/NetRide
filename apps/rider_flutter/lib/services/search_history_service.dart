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

  factory HistoryRouteInfo.fromJson(Map<String, dynamic> json) => HistoryRouteInfo(
    distanceMeters: (json['distanceMeters'] as num).toDouble(),
    durationSeconds: (json['durationSeconds'] as num).toDouble(),
    trafficDurationSeconds: (json['trafficDurationSeconds'] as num?)?.toDouble(),
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
    } catch (_) {
      return [];
    }
  }

  Future<void> save(SearchResult result, {HistoryRouteInfo? routeInfo}) async {
    try {
      final data = <String, dynamic>{
        'display_name': result.displayName,
        'lat': result.lat,
        'lon': result.lon,
        'state': result.state,
        'type': result.type,
        if (result.distanceMiles != null) 'distance_miles': result.distanceMiles,
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

  Future<void> saveRouteOnly({
    required double originLat,
    required double originLng,
    required double destLat,
    required double destLng,
    required double distanceMeters,
    required double durationSeconds,
    double? trafficDurationSeconds,
  }) async {
    try {
      final originHash = SpatialHash.encode(originLat, originLng, 7);
      final destHash = SpatialHash.encode(destLat, destLng, 7);

      await ApiService.dio.post('user/search-history/route', data: {
        'origin_lat': originLat,
        'origin_lng': originLng,
        'dest_lat': destLat,
        'dest_lng': destLng,
        'origin_geohash': originHash,
        'dest_geohash': destHash,
        'distance_meters': distanceMeters,
        'duration_seconds': durationSeconds,
        'traffic_duration_seconds': trafficDurationSeconds,
      });
    } catch (_) {}
  }

  Future<List<Map<String, dynamic>>> fetchRecentRoutes() async {
    try {
      final response = await ApiService.dio.get('user/search-history/routes');
      if (response.data is! List) return [];
      return (response.data as List).cast<Map<String, dynamic>>();
    } catch (_) {
      return [];
    }
  }
}
