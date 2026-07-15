import 'package:flutter/foundation.dart';
import '../services/user_service.dart';
import 'cache_service.dart';
import 'cache_keys.dart';
import 'cache_policy.dart';

/// Cache-first repository wrapping [UserService].
///
/// Every read follows this flow:
///   1. Check L1/L2 cache for the requested data category.
///   2. If found and NOT expired, return immediately (with staleness info).
///   3. Trigger background revalidation if entry is stale or missing.
///   4. Background fetch calls server -> updates cache -> notifies listeners.
///
/// Mutations invalidate affected cache keys after confirming server success.

class CacheResult<T> {
  final T? data;
  final bool fromCache;
  final Staleness staleness;

  const CacheResult({
    this.data,
    this.fromCache = false,
    this.staleness = Staleness.expired,
  });

  bool get needsRevalidation => fromCache && staleness != Staleness.fresh;
}

class UserCacheRepository {
  final CacheService _cache;
  String? _driverId;

  UserCacheRepository() : _cache = CacheService.instance;

  void setDriverId(String? id) {
    _driverId = id;
  }

  /// The currently-set driver ID. Throws if not set.
  String get driverId {
    if (_driverId == null || _driverId!.isEmpty) {
      throw StateError('Driver ID not set. Call setDriverId() first.');
    }
    return _driverId!;
  }

  // ── CLASS A: Profile ─────────────────────────────────────────────

  /// Returns cached profile immediately, fetches in background if stale.
  Future<Map<String, dynamic>> getProfile({
    bool forceRefresh = false,
  }) async {
    if (!forceRefresh) {
      final cached = _cache.get(CacheKeys.driverProfile(driverId));
      if (cached != null) {
        return Map<String, dynamic>.from(cached as Map);
      }
    }
    try {
      final profile = await UserService.getProfile();
      await _cache.set(
        CacheKeys.driverProfile(driverId),
        profile,
        CachePolicy.profile,
      );
      return profile;
    } catch (e) {
      final cached = _cache.get(CacheKeys.driverProfile(driverId));
      if (cached != null) return Map<String, dynamic>.from(cached as Map);
      rethrow;
    }
  }

  /// Fetch profile silently in background and update cache.
  Future<void> revalidateProfile() async {
    try {
      final profile = await UserService.getProfile();
      await _cache.set(
        CacheKeys.driverProfile(driverId),
        profile,
        CachePolicy.profile,
      );
    } catch (e) {
      debugPrint('[CACHE] Profile revalidation failed: $e');
    }
  }

  /// After a successful profile mutation, re-fetch authoritative state.
  Future<Map<String, dynamic>> refreshProfile() async {
    await _cache.invalidate(CacheKeys.driverProfile(driverId));
    return getProfile(forceRefresh: true);
  }

  // ── CLASS A: Profile Picture Reference ───────────────────────────

  String? getCachedProfilePictureUrl() {
    final cached = _cache.get(CacheKeys.driverProfilePicture(driverId));
    return cached as String?;
  }

  Future<void> cacheProfilePictureUrl(String url) async {
    await _cache.set(
      CacheKeys.driverProfilePicture(driverId),
      url,
      CachePolicy.profilePicture,
    );
  }

  // ── CLASS A: Vehicle ─────────────────────────────────────────────

  Map<String, dynamic>? getCachedVehicle() {
    final cached = _cache.get(CacheKeys.driverVehicle(driverId));
    if (cached != null) return Map<String, dynamic>.from(cached as Map);
    return null;
  }

  Future<void> cacheVehicle(Map<String, dynamic> vehicle) async {
    await _cache.set(
      CacheKeys.driverVehicle(driverId),
      vehicle,
      CachePolicy.vehicle,
    );
  }

  // ── CLASS B: Verification Status ─────────────────────────────────

  String? getCachedVerificationStatus() {
    final cached = _cache.get(CacheKeys.driverVerificationStatus(driverId));
    return cached as String?;
  }

  Future<void> cacheVerificationStatus(String status) async {
    await _cache.set(
      CacheKeys.driverVerificationStatus(driverId),
      status,
      CachePolicy.verificationStatus,
    );
  }

  // ── CLASS B: Document Requirements ───────────────────────────────

  List<Map<String, dynamic>>? getCachedDocumentRequirements() {
    final cached = _cache.get(CacheKeys.driverDocumentRequirements(driverId));
    if (cached is List) {
      return cached.map((e) => Map<String, dynamic>.from(e as Map)).toList();
    }
    return null;
  }

  Future<void> cacheDocumentRequirements(List<Map<String, dynamic>> reqs) async {
    await _cache.set(
      CacheKeys.driverDocumentRequirements(driverId),
      reqs,
      CachePolicy.documentRequirements,
    );
  }

  Future<List<Map<String, dynamic>>> fetchDocumentRequirements() async {
    final cached = _cache.get(CacheKeys.driverDocumentRequirements(driverId));
    if (cached != null) {
      final reqs = (cached as List).map((e) => Map<String, dynamic>.from(e as Map)).toList();
      // Return cached immediately, refresh in background
      revalidateDocumentRequirements();
      return reqs;
    }
    try {
      final docReqs = await UserService.getDocumentRequirements();
      final reqs = (docReqs['requirements'] as List?)
              ?.map((r) => Map<String, dynamic>.from(r as Map))
              .toList() ??
          [];
      await _cache.set(
        CacheKeys.driverDocumentRequirements(driverId),
        reqs,
        CachePolicy.documentRequirements,
      );
      return reqs;
    } catch (e) {
      rethrow;
    }
  }

  Future<void> revalidateDocumentRequirements() async {
    try {
      final docReqs = await UserService.getDocumentRequirements();
      final reqs = (docReqs['requirements'] as List?)
              ?.map((r) => Map<String, dynamic>.from(r as Map))
              .toList() ??
          [];
      await _cache.set(
        CacheKeys.driverDocumentRequirements(driverId),
        reqs,
        CachePolicy.documentRequirements,
      );
    } catch (e) {
      debugPrint('[CACHE] Doc req revalidation failed: $e');
    }
  }

  // ── CLASS B: Profile Change Pending ──────────────────────────────

  bool? getCachedHasPendingProfileChange() {
    final cached = _cache.get(CacheKeys.driverProfileChange(driverId));
    if (cached is Map) return cached['has_pending'] == true;
    return null;
  }

  Future<void> cacheProfileChangePending(Map<String, dynamic>? data) async {
    if (data != null) {
      await _cache.set(
        CacheKeys.driverProfileChange(driverId),
        data,
        CachePolicy.profileChange,
      );
    } else {
      await _cache.invalidate(CacheKeys.driverProfileChange(driverId));
    }
  }

  // ── Mutation invalidation helpers ────────────────────────────────

  /// Call after a successful profile change submission.
  Future<void> invalidateAfterProfileChange() async {
    await _cache.invalidateAll([
      CacheKeys.driverProfile(driverId),
      CacheKeys.driverProfileChange(driverId),
      CacheKeys.driverEligibility(driverId),
    ]);
  }

  /// Call after a successful document resubmission.
  Future<void> invalidateAfterDocumentResubmit() async {
    await _cache.invalidateAll([
      CacheKeys.driverDocumentRequirements(driverId),
      CacheKeys.driverProfile(driverId),
    ]);
  }

  /// Call after vehicle submission or resubmission.
  Future<void> invalidateAfterVehicleChange() async {
    await _cache.invalidateAll([
      CacheKeys.driverVehicle(driverId),
      CacheKeys.driverProfile(driverId),
    ]);
  }

  /// Call when a Socket.IO event indicates remote admin change.
  Future<void> invalidateForRemoteChange(String affectedKey) async {
    await _cache.invalidate(affectedKey);
  }

  /// Call when admin reviews profile change (approve/reject).
  Future<void> invalidateAfterProfileReview() async {
    await _cache.invalidateAll([
      CacheKeys.driverProfile(driverId),
      CacheKeys.driverProfileChange(driverId),
      CacheKeys.driverVerificationStatus(driverId),
      CacheKeys.driverEligibility(driverId),
    ]);
  }

  /// Call when document status changes remotely.
  Future<void> invalidateAfterDocumentReview() async {
    await _cache.invalidateAll([
      CacheKeys.driverDocumentRequirements(driverId),
      CacheKeys.driverVerificationStatus(driverId),
    ]);
  }

  /// Full invalidation for critical admin actions.
  Future<void> invalidateAllComplianceState() async {
    await _cache.invalidateAll([
      CacheKeys.driverProfile(driverId),
      CacheKeys.driverVerificationStatus(driverId),
      CacheKeys.driverDocumentRequirements(driverId),
      CacheKeys.driverEligibility(driverId),
      CacheKeys.driverProfileChange(driverId),
      CacheKeys.driverVehicle(driverId),
      CacheKeys.driverLicense(driverId),
    ]);
  }

  /// Check if a cache key needs revalidation.
  bool needsRevalidation(String key) {
    return _cache.staleness(key) != Staleness.fresh;
  }
}
