import 'dart:collection';
import '../models/route_models.dart';
import '../utils/spatial_hash.dart';

class EtaCacheEntry {
  final RouteSummary summary;
  final DateTime cachedAt;

  const EtaCacheEntry({required this.summary, required this.cachedAt});

  bool get isExpired {
    final age = DateTime.now().difference(cachedAt);
    if (summary.trafficDurationSeconds != null) {
      return age.inMinutes > 15;
    }
    return age.inHours > 24;
  }
}

class EtaCacheService {
  EtaCacheService._();
  static final EtaCacheService instance = EtaCacheService._();

  final _cache = HashMap<String, EtaCacheEntry>();
  static const int _maxEntries = 500;

  RouteSummary? get({
    required double originLat,
    required double originLng,
    required double destLat,
    required double destLng,
  }) {
    _evictExpired();

    final originHash = SpatialHash.encode(originLat, originLng, 7);
    final destHash = SpatialHash.encode(destLat, destLng, 7);
    final originNeighbors = SpatialHash.neighbors(originHash);
    final destNeighbors = SpatialHash.neighbors(destHash);

    EtaCacheEntry? best;

    for (final oHash in originNeighbors) {
      for (final dHash in destNeighbors) {
        final key = 'eta:$oHash:$dHash';
        final entry = _cache[key];
        if (entry != null && !entry.isExpired) {
          if (best == null || entry.cachedAt.isAfter(best.cachedAt)) {
            best = entry;
          }
        }
      }
    }

    return best?.summary;
  }

  void set(RouteSummary summary) {
    _evictExpired();
    final key = 'eta:${summary.originHex}:${summary.destHex}';
    _cache[key] = EtaCacheEntry(summary: summary, cachedAt: DateTime.now());

    if (_cache.length > _maxEntries) {
      _evictLru();
    }
  }

  void invalidate(double originLat, double originLng, double destLat, double destLng) {
    final originHash = SpatialHash.encode(originLat, originLng, 7);
    final destHash = SpatialHash.encode(destLat, destLng, 7);
    final originNeighbors = SpatialHash.neighbors(originHash);
    final destNeighbors = SpatialHash.neighbors(destHash);

    for (final oHash in originNeighbors) {
      for (final dHash in destNeighbors) {
        _cache.remove('eta:$oHash:$dHash');
      }
    }
  }

  void clear() {
    _cache.clear();
  }

  void _evictExpired() {
    _cache.removeWhere((_, entry) => entry.isExpired);
  }

  void _evictLru() {
    if (_cache.length <= _maxEntries) return;
    final sorted = _cache.entries.toList()
      ..sort((a, b) => a.value.cachedAt.compareTo(b.value.cachedAt));
    final toRemove = _cache.length - _maxEntries;
    for (int i = 0; i < toRemove; i++) {
      _cache.remove(sorted[i].key);
    }
  }
}
