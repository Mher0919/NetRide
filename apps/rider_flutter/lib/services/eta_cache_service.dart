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

  /// True when this entry predates the fare-in-plan fix (no saved fare).
  /// It is still served instantly, but the caller refreshes it in the
  /// background so the price converges without any visible cache loss.
  bool get needsFareRefresh => fareTotal == null || fareTotal! <= 0;

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
  static const String _diskPrefix = 'rider_eta_cache:';

  Future<void> init(SharedPreferences prefs) async {
    _prefs = prefs;
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
