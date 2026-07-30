import 'package:dio/dio.dart';
import '../../models/search_result.dart';
import '../api_service.dart';
import 'search_cache.dart';
import 'search_config.dart';

class SearchService {
  final SearchCache _cache = SearchCache.instance;
  CancelToken? _cancelToken;

  void cancelPending() {
    _cancelToken?.cancel();
    _cancelToken = null;
  }

  Future<List<SearchResult>> search({
    required String query,
    double? lat,
    double? lon,
  }) async {
    final trimmed = query.trim();
    if (trimmed.length < SearchConfig.minQueryLength) return [];

    final cached = _cache.get(query: trimmed, lat: lat, lon: lon);
    if (cached != null) {
      return cached.map((j) => SearchResult.fromJson(j)).toList();
    }

    cancelPending();
    _cancelToken = CancelToken();

    try {
      final params = <String, dynamic>{
        'q': trimmed,
        if (lat != null) 'lat': lat,
        if (lon != null) 'lon': lon,
      };

      final response = await ApiService.dio.get(
        'geospatial/search',
        queryParameters: params,
        cancelToken: _cancelToken,
        options: Options(
          sendTimeout: Duration(seconds: SearchConfig.requestTimeoutSeconds),
          receiveTimeout: Duration(seconds: SearchConfig.requestTimeoutSeconds),
        ),
      );

      if (response.data is! List) return [];

      final rawList = (response.data as List).cast<Map<String, dynamic>>();

      final cleaned = _cleanResults(rawList);

      _cache.set(query: trimmed, data: cleaned, lat: lat, lon: lon);

      return cleaned.map((j) => SearchResult.fromJson(j)).toList();
    } on DioException catch (e) {
      if (e.type == DioExceptionType.cancel) {
        return [];
      }
      rethrow;
    }
  }

  List<Map<String, dynamic>> _cleanResults(List<Map<String, dynamic>> results) {
    final seen = <String>{};
    final cleaned = <Map<String, dynamic>>[];

    for (final item in results) {
      final name = (item['display_name'] as String?)?.trim() ?? '';
      if (name.isEmpty) continue;

      final lat = item['lat'];
      final lon = item['lon'];
      if (lat == null || lon == null) continue;
      // Skip zero-coordinate results unless they're static suggestions
      if (lat == 0 && lon == 0 && item['is_suggestion'] != true) continue;

      final key = name.toLowerCase();
      if (seen.contains(key)) continue;
      seen.add(key);

      cleaned.add(item);
    }

    return cleaned;
  }
}
