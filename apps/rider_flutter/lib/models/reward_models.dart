// lib/models/reward_models.dart
//
// Models for the rewards ecosystem API: ride credits, referrals, promos.

class ReferralInfo {
  final String code;
  final String qrPayload;
  final String referralUrl;
  final DateTime issuedAt;
  final DateTime expiresAt;
  final bool canScan;
  final String? relationshipStatus;
  final String? referrerName;
  final int referredCount;
  final int rewardsEarnedCents;
  final List<ReferralHistoryEntry> history;

  const ReferralInfo({
    required this.code,
    required this.qrPayload,
    required this.referralUrl,
    required this.issuedAt,
    required this.expiresAt,
    required this.canScan,
    this.relationshipStatus,
    this.referrerName,
    required this.referredCount,
    required this.rewardsEarnedCents,
    required this.history,
  });

  factory ReferralInfo.fromJson(Map<String, dynamic> json) {
    final rawHistory = (json['history'] as List?) ?? const [];
    return ReferralInfo(
      code: json['code'] as String? ?? '',
      qrPayload: json['qr_payload'] as String? ?? '',
      referralUrl: json['referral_url'] as String? ?? '',
      issuedAt: DateTime.tryParse(json['issued_at'] as String? ?? '') ?? DateTime.now(),
      expiresAt: DateTime.tryParse(json['expires_at'] as String? ?? '') ?? DateTime.now(),
      canScan: json['can_scan'] as bool? ?? false,
      relationshipStatus: json['relationship_status'] as String?,
      referrerName: (json['referrer'] as Map<String, dynamic>?)?['full_name'] as String?,
      referredCount: json['referred_count'] as int? ?? 0,
      rewardsEarnedCents: json['rewards_earned_cents'] as int? ?? 0,
      history: rawHistory
          .map((e) => ReferralHistoryEntry.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }
}

class ReferralHistoryEntry {
  final String id;
  final String? friendName;
  final String? friendEmail;
  final String status;
  final DateTime? scannedAt;
  final DateTime? firstRideCompletedAt;
  final DateTime? rewardGrantedAt;
  final int amountCents;

  const ReferralHistoryEntry({
    required this.id,
    this.friendName,
    this.friendEmail,
    required this.status,
    this.scannedAt,
    this.firstRideCompletedAt,
    this.rewardGrantedAt,
    required this.amountCents,
  });

  factory ReferralHistoryEntry.fromJson(Map<String, dynamic> json) {
    return ReferralHistoryEntry(
      id: json['id'] as String? ?? '',
      friendName: json['friend_name'] as String?,
      friendEmail: json['friend_email'] as String?,
      status: json['status'] as String? ?? '',
      scannedAt: DateTime.tryParse(json['scanned_at'] as String? ?? ''),
      firstRideCompletedAt: DateTime.tryParse(json['first_ride_completed_at'] as String? ?? ''),
      rewardGrantedAt: DateTime.tryParse(json['reward_granted_at'] as String? ?? ''),
      amountCents: json['amount_cents'] as int? ?? 0,
    );
  }
}

class CreditAccount {
  final String userId;
  final int balanceCents;
  final int lifetimeEarnedCents;

  const CreditAccount({
    required this.userId,
    required this.balanceCents,
    required this.lifetimeEarnedCents,
  });

  factory CreditAccount.fromJson(Map<String, dynamic> json) {
    return CreditAccount(
      userId: json['user_id'] as String? ?? '',
      balanceCents: json['balance_cents'] as int? ?? 0,
      lifetimeEarnedCents: json['lifetime_earned_cents'] as int? ?? 0,
    );
  }
}

class CreditTransaction {
  final String id;
  final int amountCents;
  final String type;
  final String? referenceType;
  final String? referenceId;
  final String? rideId;
  final String? description;
  final int balanceAfterCents;
  final DateTime createdAt;

  const CreditTransaction({
    required this.id,
    required this.amountCents,
    required this.type,
    this.referenceType,
    this.referenceId,
    this.rideId,
    this.description,
    required this.balanceAfterCents,
    required this.createdAt,
  });

  factory CreditTransaction.fromJson(Map<String, dynamic> json) {
    return CreditTransaction(
      id: json['id'] as String? ?? '',
      amountCents: json['amount_cents'] as int? ?? 0,
      type: json['type'] as String? ?? '',
      referenceType: json['reference_type'] as String?,
      referenceId: json['reference_id'] as String?,
      rideId: json['ride_id'] as String?,
      description: json['description'] as String?,
      balanceAfterCents: json['balance_after_cents'] as int? ?? 0,
      createdAt: DateTime.tryParse(json['created_at'] as String? ?? '') ?? DateTime.now(),
    );
  }
}

class PromoPreview {
  final bool valid;
  final String? code;
  final String? reason;
  final int? discountCents;
  final int? fareCents;
  final int? finalCents;
  final String? discountLabel;
  final String? partnerName;
  final int? maxDiscountCents;

  const PromoPreview({
    required this.valid,
    this.code,
    this.reason,
    this.discountCents,
    this.fareCents,
    this.finalCents,
    this.discountLabel,
    this.partnerName,
    this.maxDiscountCents,
  });

  factory PromoPreview.fromJson(Map<String, dynamic> json) {
    return PromoPreview(
      valid: json['valid'] as bool? ?? false,
      code: json['code'] as String?,
      reason: json['reason'] as String?,
      discountCents: json['discount_cents'] as int?,
      fareCents: json['fare_cents'] as int?,
      finalCents: json['final_cents'] as int?,
      discountLabel: json['discount_label'] as String?,
      partnerName: json['partner_name'] as String?,
      maxDiscountCents: json['max_discount_cents'] as int?,
    );
  }
}

String formatCents(int cents) {
  final dollars = cents / 100.0;
  final sign = dollars < 0 ? '-' : '';
  return '$sign\$${dollars.abs().toStringAsFixed(2)}';
}
