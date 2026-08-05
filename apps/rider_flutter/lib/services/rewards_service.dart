// lib/services/rewards_service.dart
//
// Static client for the rewards ecosystem endpoints:
//   GET  /api/referral           → my code + QR payload + history
//   GET  /api/referral/history   → referral status feed
//   POST /api/referral/scan      → link a scanned QR / link
//   GET  /api/credits            → balance
//   GET  /api/credits/transactions → ledger
//   POST /api/promo/validate     → promo preview for checkout

import 'package:dio/dio.dart';
import '../models/reward_models.dart';
import 'api_service.dart';

class RewardsService {
  /// Full referral snapshot: code, QR payload, URL, stats + history.
  static Future<ReferralInfo> getReferralInfo() async {
    final res = await ApiService.dio.get('referral');
    return ReferralInfo.fromJson(res.data as Map<String, dynamic>);
  }

  static Future<List<ReferralHistoryEntry>> getReferralHistory() async {
    final res = await ApiService.dio.get('referral/history');
    final raw = (res.data as Map<String, dynamic>)['history'] as List? ?? [];
    return raw
        .map((e) => ReferralHistoryEntry.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// Processes a referral scan. Returns the created relationship info.
  static Future<Map<String, dynamic>> scanReferral({
    String? payload,
    String? url,
  }) async {
    final res = await ApiService.dio.post('referral/scan', data: {
      if (payload != null) 'payload': payload,
      if (url != null) 'url': url,
    });
    return res.data as Map<String, dynamic>;
  }

  static Future<CreditAccount> getCredits() async {
    final res = await ApiService.dio.get('credits');
    return CreditAccount.fromJson(res.data as Map<String, dynamic>);
  }

  static Future<List<CreditTransaction>> getCreditTransactions({
    int limit = 50,
    int offset = 0,
  }) async {
    final res = await ApiService.dio.get('credits/transactions', queryParameters: {
      'limit': limit,
      'offset': offset,
    });
    final raw = (res.data as Map<String, dynamic>)['transactions'] as List? ?? [];
    return raw
        .map((e) => CreditTransaction.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// Preview-only promo check. Never writes; authoritative check happens
  /// server-side at ride request.
  static Future<PromoPreview> validatePromo(
    String code, {
    double? distanceMeters,
    double? durationSeconds,
  }) async {
    try {
      final res = await ApiService.dio.post('promo/validate', data: {
        'code': code,
        if (distanceMeters != null) 'distanceMeters': distanceMeters,
        if (durationSeconds != null) 'durationSeconds': durationSeconds,
      });
      return PromoPreview.fromJson(res.data as Map<String, dynamic>);
    } on DioException catch (e) {
      final data = e.response?.data;
      if (data is Map && data['valid'] == false) {
        return PromoPreview(valid: false, code: code.toUpperCase(), reason: data['reason'] as String?);
      }
      rethrow;
    }
  }
}
