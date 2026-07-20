import 'search_config.dart';

class CachedSearchResult {
  final List<Map<String, dynamic>> data;
  final DateTime cachedAt;

  CachedSearchResult(this.data, this.cachedAt);

  bool get isExpired =>
      DateTime.now().difference(cachedAt).inMinutes >=
      SearchConfig.cacheTtlMinutes;
}

class SearchCache {
  static final SearchCache _instance = SearchCache._();
  static SearchCache get instance => _instance;
  SearchCache._();

  final _cache = <String, CachedSearchResult>{};

  String _buildKey({
    required String query,
    double? lat,
    double? lon,
    String language = SearchConfig.defaultLanguage,
  }) {
    final latKey = lat?.toStringAsFixed(2) ?? '0';
    final lonKey = lon?.toStringAsFixed(2) ?? '0';
    return '${query.trim().toLowerCase()}|$latKey|$lonKey|$language';
  }

  List<Map<String, dynamic>>? get({
    required String query,
    double? lat,
    double? lon,
    String language = SearchConfig.defaultLanguage,
  }) {
    final key = _buildKey(
      query: query,
      lat: lat,
      lon: lon,
      language: language,
    );
    final cached = _cache[key];
    if (cached == null) return null;
    if (cached.isExpired) {
      _cache.remove(key);
      return null;
    }
    return cached.data;
  }

  void set({
    required String query,
    required List<Map<String, dynamic>> data,
    double? lat,
    double? lon,
    String language = SearchConfig.defaultLanguage,
  }) {
    if (data.isEmpty) return;
    final key = _buildKey(
      query: query,
      lat: lat,
      lon: lon,
      language: language,
    );
    _cache[key] = CachedSearchResult(data, DateTime.now());

    if (_cache.length > 100) {
      _cache.remove(_cache.keys.first);
    }
  }

  void invalidateQuery(String query) {
    _cache.removeWhere((key, _) => key.startsWith(query.toLowerCase()));
  }

  void clear() {
    _cache.clear();
  }
}
