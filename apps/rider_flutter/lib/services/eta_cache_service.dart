import 'dart:collection';
import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import '../utils/spatial_hash.dart';

class CachedEtaData {
  final double distanceMeters;
  final double durationSeconds;
  final double? trafficDurationSeconds;
  final DateTime cachedAt;
  /// Backend-computed fare total (single source of truth), cached with the
  /// ETA so cached estimates never re-derive pricing client-side.
  final double? fareTotal;

  const CachedEtaData({
    required this.distanceMeters,
    required this.durationSeconds,
    this.trafficDurationSeconds,
    required this.cachedAt,
    this.fareTotal,
  });

  /// Cached ETAs always render instantly — TTL is the only expiry rule.
  bool get isExpired {
    final age = DateTime.now().difference(cachedAt);
    if (trafficDurationSeconds != null) return age.inMinutes > 15;
    return age.inHours > 24;
  }

  /// True when this entry should be re-priced in the background: no saved
  /// fare (pre-fare-in-plan entries) OR an aged fare. Fares are
  /// backend-authoritative and can change (admin pricing edits), so a cached
  /// price older than [kFareMaxAge] is refreshed while the stale value keeps
  /// rendering instantly — the price converges without visible cache loss.
  static const Duration kFareMaxAge = Duration(hours: 6);

  bool get needsFareRefresh {
    if (fareTotal == null || fareTotal! <= 0) return true;
    return DateTime.now().difference(cachedAt) >= kFareMaxAge;
  }

  Map<String, dynamic> toJson() => {
    'distanceMeters': distanceMeters,
    'durationSeconds': durationSeconds,
    'trafficDurationSeconds': trafficDurationSeconds,
    'cachedAt': cachedAt.toIso8601String(),
    'fareTotal': fareTotal,
  };

  factory CachedEtaData.fromJson(Map<String, dynamic> json) => CachedEtaData(
    distanceMeters: (json['distanceMeters'] as num).toDouble(),
    durationSeconds: (json['durationSeconds'] as num).toDouble(),
    trafficDurationSeconds: (json['trafficDurationSeconds'] as num?)?.toDouble(),
    cachedAt: DateTime.parse(json['cachedAt'] as String),
    fareTotal: (json['fareTotal'] as num?)?.toDouble(),
  );
}

class EtaCacheService {
  EtaCacheService._();
  static final EtaCacheService instance = EtaCacheService._();

  SharedPreferences? _prefs;
  final _memoryCache = HashMap<String, CachedEtaData>();
  // v2: fares are always the backend-computed value. Bumping the namespace
  // guarantees pre-v2 entries (stale minimum-fare prices from the old
  // pricing era) can never be served — the first panel open after the app
  // updates fetches fresh route + fare data from the backend.
  static const String _diskPrefix = 'rider_eta_cache:v2:';
  static const String _legacyCleanupKey = 'rider_eta_cache:v2_cleanup_done';

  Future<void> init(SharedPreferences prefs) async {
    _prefs = prefs;
    if (prefs.getBool(_legacyCleanupKey) != true) {
      final legacy = prefs
          .getKeys()
          .where((k) => k.startsWith('rider_eta_cache:') && !k.startsWith(_diskPrefix))
          .toList();
      for (final key in legacy) {
        await prefs.remove(key);
      }
      await prefs.setBool(_legacyCleanupKey, true);
    }
  }

  CachedEtaData? get({
    required double originLat,
    required double originLng,
    required double destLat,
    required double destLng,
  }) {
    final originHash = SpatialHash.encode(originLat, originLng);
    final destHash = SpatialHash.encode(destLat, destLng);
    final originNeighbors = SpatialHash.neighbors(originHash);
    final destNeighbors = SpatialHash.neighbors(destHash);

    for (final oHash in originNeighbors) {
      for (final dHash in destNeighbors) {
        final key = 'eta:$oHash:$dHash';

        final memEntry = _memoryCache[key];
        if (memEntry != null && !memEntry.isExpired) return memEntry;

        final diskEntry = _readFromDisk(key);
        if (diskEntry != null && !diskEntry.isExpired) {
          _memoryCache[key] = diskEntry;
          return diskEntry;
        }
      }
    }

    return null;
  }

  Future<void> set({
    required double originLat,
    required double originLng,
    required double destLat,
    required double destLng,
    required double distanceMeters,
    required double durationSeconds,
    double? trafficDurationSeconds,
    double? fareTotal,
  }) async {
    final originHash = SpatialHash.encode(originLat, originLng);
    final destHash = SpatialHash.encode(destLat, destLng);
    final key = 'eta:$originHash:$destHash';

    final data = CachedEtaData(
      distanceMeters: distanceMeters,
      durationSeconds: durationSeconds,
      trafficDurationSeconds: trafficDurationSeconds,
      cachedAt: DateTime.now(),
      fareTotal: fareTotal,
    );

    _memoryCache[key] = data;
    await _writeToDisk(key, data);
  }

  Future<void> clear() async {
    _memoryCache.clear();
    if (_prefs != null) {
      final keys = _prefs!.getKeys().where((k) => k.startsWith(_diskPrefix)).toList();
      for (final key in keys) {
        await _prefs!.remove(key);
      }
    }
  }

  CachedEtaData? _readFromDisk(String key) {
    if (_prefs == null) return null;
    final raw = _prefs!.getString('$_diskPrefix$key');
    if (raw == null) return null;
    try {
      return CachedEtaData.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      _prefs!.remove('$_diskPrefix$key');
      return null;
    }
  }

  Future<void> _writeToDisk(String key, CachedEtaData data) async {
    if (_prefs == null) return;
    try {
      await _prefs!.setString('$_diskPrefix$key', jsonEncode(data.toJson()));
    } catch (_) {}
  }
}
