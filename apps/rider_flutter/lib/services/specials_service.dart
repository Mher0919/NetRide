// lib/services/specials_service.dart
//
// Static client for the rider-facing SPECIALS endpoints (spec §27-31, §125):
//   GET  /api/specials                     → eligible sponsor discovery
//   GET  /api/specials/count               → SPECIALS button visibility
//   GET  /api/specials/:id                 → sponsor detail
//   GET  /api/specials/intro-state         → has this rider seen the intro?
//   POST /api/specials/intro-seen          → persist intro acknowledgment
//   POST /api/specials/:id/redemption      → step 1: rider picks a sponsor
//   GET  /api/specials/redemptions/current → resumable redemption on restart
//   POST /api/specials/redemptions/:id/verified → step 4: "I got verified"
//   POST /api/specials/redemptions/:id/reward   → step 5: REFUND or CREDITS

import 'package:dio/dio.dart';
import '../models/special_models.dart';
import 'api_service.dart';

class SpecialsService {
  static Future<List<SponsorSpecial>> list({int limit = 50}) async {
    final res = await ApiService.dio.get('specials', queryParameters: {
      'limit': limit,
    });
    final raw = (res.data as Map<String, dynamic>)['sponsors'] as List? ?? [];
    return raw
        .map((e) => SponsorSpecial.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  static Future<int> count() async {
    final res = await ApiService.dio.get('specials/count');
    return (res.data as Map<String, dynamic>)['count'] as int? ?? 0;
  }

  static Future<SponsorSpecial> getOne(String id) async {
    final res = await ApiService.dio.get('specials/$id');
    final json = (res.data as Map<String, dynamic>)['sponsor'];
    return SponsorSpecial.fromJson(json as Map<String, dynamic>);
  }

  /// Has this rider acknowledged the SPECIALS intro? Backend authoritative.
  static Future<bool> introSeen() async {
    final res = await ApiService.dio.get('specials/intro-state');
    return (res.data as Map<String, dynamic>)['seen'] as bool? ?? false;
  }

  static Future<void> markIntroSeen() async {
    await ApiService.dio.post('specials/intro-seen');
  }

  /// Step 1 — rider picks a sponsor. Returns the CREATED redemption whose id
  /// is sent with the next ride request (`specialRedemptionId`).
  static Future<SpecialRedemption> createRedemption(String sponsorId) async {
    final res = await ApiService.dio.post('specials/$sponsorId/redemption');
    final json = (res.data as Map<String, dynamic>)['redemption'];
    return SpecialRedemption.fromJson(json as Map<String, dynamic>);
  }

  /// The rider's resumable redemption (app restart / foreground resync).
  static Future<SpecialRedemption?> currentRedemption() async {
    final res = await ApiService.dio.get('specials/redemptions/current');
    final json = (res.data as Map<String, dynamic>)['redemption'];
    return json == null ? null : SpecialRedemption.fromJson(json as Map<String, dynamic>);
  }

  /// Step 4 — rider tells the backend they've been verified at the business.
  static Future<SpecialRedemption> markVerified(String redemptionId) async {
    final res = await ApiService.dio.post('specials/redemptions/$redemptionId/verified');
    final json = (res.data as Map<String, dynamic>)['redemption'];
    return SpecialRedemption.fromJson(json as Map<String, dynamic>);
  }

  /// Step 5 — reward choice: REFUND (D back to wallet) or CREDITS (D×1.10).
  /// Both are idempotent; the backend settles atomically.
  static Future<SpecialRedemption> chooseReward(
    String redemptionId,
    String choice, {
    required bool confirmed,
  }) async {
    final res = await ApiService.dio.post(
      'specials/redemptions/$redemptionId/reward',
      data: {'choice': choice, 'confirmed': confirmed},
    );
    final json = (res.data as Map<String, dynamic>)['redemption'];
    return SpecialRedemption.fromJson(json as Map<String, dynamic>);
  }

  /// Recovers the one-time validation code from in-app notification history
  /// (delivered only to this rider via `special_reward_ready`; spec §99).
  /// Returns null when the code has aged out of the history window.
  static Future<String?> recoverCode(String redemptionId) async {
    try {
      final res = await ApiService.dio.get('notifications', queryParameters: {
        'limit': 50,
      });
      final items = (res.data as Map<String, dynamic>)['notifications'] as List? ?? [];
      for (final item in items) {
        final n = item as Map<String, dynamic>;
        if (n['type'] != 'special_reward_ready') continue;
        final data = (n['data'] as Map<String, dynamic>?) ?? {};
        if (data['redemptionId'] != redemptionId) continue;
        final code = data['code'] as String?;
        if (code != null && code.isNotEmpty) return code;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  /// Maps structured Dio errors to friendly, rider-safe copy.
  static String friendlyError(DioException e) {
    final code = e.response?.data is Map ? (e.response!.data as Map)['error'] : null;
    if (code is String && code.isNotEmpty) return code;
    return 'Something went wrong. Please try again.';
  }
}
