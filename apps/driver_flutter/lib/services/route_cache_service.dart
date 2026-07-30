import 'dart:collection';
import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/route_models.dart';
import '../utils/spatial_hash.dart';

class RouteCacheEntry {
  final RouteResponse route;
  final DateTime cachedAt;
  final int accessCount;

  const RouteCacheEntry({
    required this.route,
    required this.cachedAt,
    this.accessCount = 1,
  });

  RouteCacheEntry copyWith({int? accessCount}) =>
      RouteCacheEntry(
        route: route,
        cachedAt: cachedAt,
        accessCount: accessCount ?? this.accessCount,
      );

  bool get isExpired {
    final age = DateTime.now().difference(cachedAt);
    if (route.trafficDurationSeconds != null) {
      return age.inMinutes > 15;
    }
    return age.inDays > 7;
  }
}

class RouteCacheService {
  RouteCacheService._();
  static final RouteCacheService instance = RouteCacheService._();

  SharedPreferences? _prefs;
  final _memoryCache = HashMap<String, RouteCacheEntry>();

  static const int _maxMemoryEntries = 200;
  static const String _diskPrefix = 'route_cache_v2:';

  Future<void> init(SharedPreferences prefs) async {
    _prefs = prefs;
    _evictExpired();
  }

  RouteResponse? get({
    required double originLat,
    required double originLng,
    required double destLat,
    required double destLng,
    int searchRadius = 2,
  }) {
    final originHash = SpatialHash.encode(originLat, originLng);
    final destHash = SpatialHash.encode(destLat, destLng);

    final originNeighbors = SpatialHash.neighbors(originHash);
    final destNeighbors = SpatialHash.neighbors(destHash);

    RouteCacheEntry? bestEntry;
    int bestScore = -1;

    for (final oHash in originNeighbors) {
      for (final dHash in destNeighbors) {
        final key = '${SpatialHash.routeCacheKey(0, 0, 0, 0).split(':')[0]}:$oHash:$dHash';
        final entry = _memoryCache[key];

        if (entry != null && !entry.isExpired) {
          final score = _proximityScore(originHash, destHash, oHash, dHash);
          if (score > bestScore) {
            bestScore = score;
            bestEntry = entry;
          }
        }
      }
    }

    if (bestEntry != null) {
      _promoteEntry('route:$originHash:$destHash', bestEntry);
      return bestEntry.route;
    }

    final diskEntry = _readFromDisk(originHash, destHash, originNeighbors, destNeighbors);
    if (diskEntry != null) {
      _memoryCache['route:$originHash:$destHash'] = diskEntry;
      return diskEntry.route;
    }

    return null;
  }

  Future<void> set(RouteResponse route) async {
    final key = 'route:${route.originHex}:${route.destHex}';
    final entry = RouteCacheEntry(route: route, cachedAt: DateTime.now());

    _memoryCache[key] = entry;

    if (_memoryCache.length > _maxMemoryEntries) {
      _evictLru();
    }

    await _writeToDisk(key, entry);
  }

  Future<void> invalidate(double originLat, double originLng, double destLat, double destLng) async {
    final key = SpatialHash.routeCacheKey(originLat, originLng, destLat, destLng);
    _memoryCache.remove(key);
    await _prefs?.remove('$_diskPrefix$key');
  }

  Future<void> clearAll() async {
    _memoryCache.clear();
    if (_prefs != null) {
      final keys = _prefs!.getKeys()
          .where((k) => k.startsWith(_diskPrefix))
          .toList();
      for (final key in keys) {
        await _prefs!.remove(key);
      }
    }
  }

  int _proximityScore(String originHash, String destHash, String oHash, String dHash) {
    int score = 0;
    if (oHash == originHash) score += 2;
    if (dHash == destHash) score += 2;
    if (SpatialHash.isWithinRadius(oHash, originHash)) score += 1;
    if (SpatialHash.isWithinRadius(dHash, destHash)) score += 1;
    return score;
  }

  void _promoteEntry(String exactKey, RouteCacheEntry entry) {
    _memoryCache[exactKey] = entry.copyWith(accessCount: entry.accessCount + 1);
  }

  RouteCacheEntry? _readFromDisk(String originHash, String destHash, List<String> originNeighbors, List<String> destNeighbors) {
    if (_prefs == null) return null;

    for (final oHash in originNeighbors) {
      for (final dHash in destNeighbors) {
        final key = '$_diskPrefix' 'route:$oHash:$dHash';
        final prefs = _prefs;
        if (prefs == null) return null;
        final raw = prefs.getString(key);
        if (raw == null) continue;

        try {
          final data = jsonDecode(raw) as Map<String, dynamic>;
          final cachedAt = DateTime.parse(data['cachedAt'] as String);
          final entry = RouteCacheEntry(
            route: RouteResponse(
              originHex: oHash,
              destHex: dHash,
              distanceMeters: (data['distanceMeters'] as num).toDouble(),
              durationSeconds: (data['durationSeconds'] as num).toDouble(),
              trafficDurationSeconds: (data['trafficDurationSeconds'] as num?)?.toDouble(),
              polyline: const [],
              steps: const [],
              engine: data['engine'] as String? ?? 'cache',
              cacheHit: true,
            ),
            cachedAt: cachedAt,
          );

          if (!entry.isExpired) return entry;
          prefs.remove(key);
        } catch (_) {
          prefs.remove(key);
        }
      }
    }
    return null;
  }

  Future<void> _writeToDisk(String key, RouteCacheEntry entry) async {
    if (_prefs == null) return;
    try {
      final data = entry.route.toCacheJson();
      await _prefs?.setString('$_diskPrefix$key', jsonEncode(data));
    } catch (_) {}
  }

  void _evictLru() {
    if (_memoryCache.length <= _maxMemoryEntries) return;

    final sorted = _memoryCache.entries.toList()
      ..sort((a, b) => a.value.accessCount.compareTo(b.value.accessCount));

    final toRemove = _memoryCache.length - _maxMemoryEntries;
    for (int i = 0; i < toRemove; i++) {
      _memoryCache.remove(sorted[i].key);
    }
  }

  void _evictExpired() {
    _memoryCache.removeWhere((_, entry) => entry.isExpired);
  }
}
