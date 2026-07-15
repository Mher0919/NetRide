import 'dart:collection';
import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import 'cache_policy.dart';

/// Production-grade cache service with memory-first + disk persistence.
///
/// Architecture:
///   L1: In-memory `HashMap` (fastest, process lifetime)
///   L2: `SharedPreferences` (persisted across restarts, Class A only)
///
/// Every entry stores a `_CacheEntry` with the raw value, a timestamp,
/// and the policy that governs its TTL. Reads check L1 -> L2 -> miss.
/// Writes update both layers when the policy allows persistence.
///
/// Thread safety: All public methods are async because of SharedPrefs,
/// but the in-memory map is a plain HashMap (single-isolate Dart).

/// Determines how long a cache entry is considered fresh.
enum Staleness { fresh, stale, expired }

class _CacheEntry {
  final dynamic value;
  final DateTime cachedAt;
  final CachePolicy policy;

  const _CacheEntry(this.value, this.cachedAt, this.policy);

  Duration get age => DateTime.now().difference(cachedAt);

  Staleness staleness() {
    if (age <= policy.staleDuration) return Staleness.fresh;
    if (age <= policy.ttl) return Staleness.stale;
    return Staleness.expired;
  }

  bool get isFresh => staleness() == Staleness.fresh;
  bool get isStale => staleness() == Staleness.stale;
  bool get isExpired => staleness() == Staleness.expired;
}

class CacheService {
  CacheService._();
  static final CacheService instance = CacheService._();

  SharedPreferences? _prefs;
  final _store = HashMap<String, _CacheEntry>();
  bool _ready = false;

  Future<void> init(SharedPreferences prefs) async {
    _prefs = prefs;
    _ready = true;
  }

  /// Read a value from cache.
  /// Returns the value if not expired, null otherwise.
  dynamic get(String key) {
    _ensureReady();
    final entry = _store[key];
    if (entry != null) {
      if (!entry.isExpired) return entry.value;
      _store.remove(key);
      return null;
    }
    return _hydrateFromDisk(key);
  }

  /// Returns the staleness status for a key without returning the value.
  Staleness staleness(String key) {
    _ensureReady();
    final entry = _store[key];
    if (entry != null) return entry.staleness();
    final disk = _readDiskEntry(key);
    if (disk != null) return disk.staleness();
    return Staleness.expired;
  }

  /// Store a value with the given caching policy.
  Future<void> set(String key, dynamic value, CachePolicy policy) async {
    _ensureReady();
    final entry = _CacheEntry(value, DateTime.now(), policy);
    _store[key] = entry;
    if (policy.persist) {
      await _writeDiskEntry(key, entry);
    }
  }

  /// Invalidate a specific cache key (removes from both L1 and L2).
  Future<void> invalidate(String key) async {
    _ensureReady();
    _store.remove(key);
    await _prefs!.remove(key);
  }

  /// Invalidate multiple cache keys at once.
  Future<void> invalidateAll(List<String> keys) async {
    _ensureReady();
    for (final key in keys) {
      _store.remove(key);
    }
    final prefs = _prefs!;
    await Future.wait(keys.map((k) => prefs.remove(k)));
  }

  /// Clear every cache entry (used on logout).
  Future<void> clearAll() async {
    _ensureReady();
    _store.clear();
    final cachePrefixes = [
      'profile:', 'vehicle:', 'license:', 'status:',
      'documents:', 'pricing:', 'wallet:',
    ];
    final keys = _prefs!.getKeys()
        .where((k) => cachePrefixes.any((p) => k.startsWith(p)))
        .toList();
    for (final key in keys) {
      await _prefs!.remove(key);
    }
  }

  // ── Disk helpers ─────────────────────────────────────────────────

  dynamic _hydrateFromDisk(String key) {
    final entry = _readDiskEntry(key);
    if (entry == null) return null;
    if (entry.isExpired) {
      _prefs!.remove(key);
      return null;
    }
    _store[key] = entry;
    return entry.value;
  }

  _CacheEntry? _readDiskEntry(String key) {
    final raw = _prefs!.getString(key);
    if (raw == null) return null;
    try {
      final map = jsonDecode(raw) as Map<String, dynamic>;
      final value = map['v'];
      final cachedAt = DateTime.parse(map['t'] as String);
      final policy = CachePolicy.values[map['p'] as int? ?? 0];
      return _CacheEntry(value, cachedAt, policy);
    } catch (_) {
      _prefs!.remove(key);
      return null;
    }
  }

  Future<void> _writeDiskEntry(String key, _CacheEntry entry) async {
    final map = {
      'v': entry.value,
      't': entry.cachedAt.toIso8601String(),
      'p': entry.policy.index,
    };
    await _prefs!.setString(key, jsonEncode(map));
  }

  void _ensureReady() {
    if (!_ready) {
      throw StateError('CacheService not initialized. Call init() first.');
    }
  }
}
