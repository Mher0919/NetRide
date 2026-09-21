// lib/services/rewards_service.dart
//
// Static client for the rewards ecosystem endpoints:
//   GET  /api/referral                → my code + QR payload + history
//   GET  /api/referral/history        → referral status feed
//   GET  /api/referral/onboarding-status → backend-authoritative onboarding gate
//   POST /api/referral/scan           → link a scanned QR / link / manual code
//   POST /api/referral/skip           → permanently close onboarding
//   GET  /api/credits                 → balance
//   GET  /api/credits/transactions    → ledger
//   POST /api/promo/validate          → promo preview for checkout

import 'package:dio/dio.dart';
import '../models/reward_models.dart';
import 'api_service.dart';
import 'device_identity.dart';

class OnboardingStatus {
  final bool eligible;
  final String state;
  final String deviceRisk;

  const OnboardingStatus({
    required this.eligible,
    required this.state,
    required this.deviceRisk,
  });

  factory OnboardingStatus.fromJson(Map<String, dynamic> json) => OnboardingStatus(
        eligible: json['eligible'] as bool? ?? false,
        state: json['state'] as String? ?? 'USED',
        deviceRisk: json['device_risk'] as String? ?? 'NORMAL',
      );
}

/// Maps the backend's structured referral error codes to friendly copy.
/// Never exposes raw server/HTTP/exception details to the rider.
String friendlyReferralError(DioException e) {
  final code = e.response?.data is Map ? (e.response!.data as Map)['code'] : null;
  switch (code) {
    case 'SELF_REFERRAL':
      return 'This referral code cannot be used with your account.';
    case 'ALREADY_USED':
      return 'You have already used a referral code on this account.';
    case 'CODE_EXPIRED':
      return 'This referral code has expired.';
    case 'CODE_NOT_FOUND':
      return 'We could not find that referral code. Please check the code and try again.';
    case 'REFERRALS_CLOSED':
      return 'Referrals are not available for this account.';
    case 'REFERRER_UNAVAILABLE':
      return 'This referral account is unavailable.';
    case 'INVALID_LINK':
    case 'INVALID_PAYLOAD':
      return 'That referral code does not look valid. Please check the code and try again.';
  }
  return 'Something went wrong. Please try again later.';
}

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

  /// Backend-authoritative first-time referral gate. Registers this install
  /// (device fingerprint) so reward-time fraud signals are evaluated server
  /// side. Returns whether the rider may still accept a referral.
  static Future<OnboardingStatus> getOnboardingStatus() async {
    final deviceId = await DeviceIdentity.installId();
    final res = await ApiService.dio.get('referral/onboarding-status', data: {
      'device': {'deviceId': deviceId, 'platform': 'android'},
    });
    return OnboardingStatus.fromJson(res.data as Map<String, dynamic>);
  }

  /// Closes the first-time referral onboarding offer. The rider can still
  /// use a referral code later from the account page (Refer & Earn).
  /// Idempotent.
  static Future<void> skipOnboarding() async {
    await ApiService.dio.post('referral/skip');
  }

  /// Processes a referral scan: signed QR payload, referral URL, or a raw
  /// manual code. Returns the created relationship info.
  static Future<Map<String, dynamic>> scanReferral({
    String? payload,
    String? url,
    String? code,
  }) async {
    final deviceId = await DeviceIdentity.installId();
    final res = await ApiService.dio.post('referral/scan', data: {
      if (payload != null) 'payload': payload,
      if (url != null) 'url': url,
      if (code != null) 'code': code,
      'device': {'deviceId': deviceId, 'platform': 'android'},
    });
    return res.data as Map<String, dynamic>;
  }

  static Future<CreditAccount> getCredits() async {
    final res = await ApiService.dio.get('credits');
    return CreditAccount.fromJson(res.data as Map<String, dynamic>);
  }

  /// Rider wallet balance (the default payment method for ride fares).
  static Future<WalletAccount> getWallet() async {
    final res = await ApiService.dio.get('wallet');
    return WalletAccount.fromJson(res.data as Map<String, dynamic>);
  }

  static Future<List<WalletTransaction>> getWalletTransactions({
    int limit = 50,
    int offset = 0,
  }) async {
    final res = await ApiService.dio.get('wallet/transactions', queryParameters: {
      'limit': limit,
      'offset': offset,
    });
    final raw = (res.data as Map<String, dynamic>)['transactions'] as List? ?? [];
    return raw
        .map((e) => WalletTransaction.fromJson(e as Map<String, dynamic>))
        .toList();
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
