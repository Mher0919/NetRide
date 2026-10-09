// lib/services/business_place_service.dart
//
// Client for the Netride backend's Google business proxy
// (`GET /specials/:id/business`). The Google API key never reaches the app —
// the backend performs the Places calls, caching, field-mask tiering and
// attribution shaping.
//
// A short-lived in-memory cache prevents re-fetching the same Special when
// the user re-opens the sheet or moves between the card and the map marker
// (spec §22/§39).

import '../models/google_business.dart';
import 'api_service.dart';

class _CacheEntry {
  final GoogleBusinessResult result;
  final DateTime fetchedAt;
  const _CacheEntry(this.result, this.fetchedAt);
}

class BusinessPlaceService {
  BusinessPlaceService._();

  static const Duration _ttl = Duration(minutes: 20);
  static final Map<String, _CacheEntry> _cache = {};

  /// Basic details are enough for the card photo; `full` adds hours, phone,
  /// website and reviews for the expanded sheet.
  static Future<GoogleBusinessResult> fetchForSpecial(
    String sponsorId, {
    String level = 'basic',
    bool force = false,
  }) async {
    final key = '$sponsorId:$level';
    final cached = _cache[key];
    if (!force && cached != null && DateTime.now().difference(cached.fetchedAt) < _ttl) {
      return cached.result;
    }
    final res = await ApiService.dio.get(
      'specials/$sponsorId/business',
      queryParameters: {'level': level},
    );
    final result = GoogleBusinessResult.fromJson(res.data as Map<String, dynamic>);
    _cache[key] = _CacheEntry(result, DateTime.now());
    return result;
  }

  static void clearCache() => _cache.clear();
}
