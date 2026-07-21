import '../models/search_result.dart';
import '../services/api_service.dart';

/// Manages the rider's recent search history (max 5 entries).
/// Persisted server-side in Redis so it survives app reinstalls.
class SearchHistoryService {
  static final SearchHistoryService instance = SearchHistoryService._();
  SearchHistoryService._();

  /// Fetches the user's latest searches (most recent first).
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

  /// Saves a search result to the user's history (deduped by coordinates).
  Future<void> save(SearchResult result) async {
    try {
      await ApiService.dio.post('user/search-history', data: {
        'displayName': result.displayName,
        'lat': result.lat,
        'lon': result.lon,
        'state': result.state,
        'type': result.type,
      });
    } catch (_) {
      // Best-effort — never block the UI.
    }
  }

  /// Clears the user's entire search history.
  Future<void> clear() async {
    try {
      await ApiService.dio.delete('user/search-history');
    } catch (_) {}
  }
}
