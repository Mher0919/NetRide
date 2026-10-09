// lib/models/special_models.dart
//
// Models for the SPECIALS ecosystem: sponsor discovery + the redemption
// lifecycle (CREATED → RIDE_PENDING → WAITING_FOR_SPONSOR →
// SPONSOR_VALIDATED → REWARD_COMPLETED). Money is integer cents and always
// computed server-side; clients only render it.

class SponsorDiscount {
  final String type;
  final int? percent;
  final int? maxPercent;
  final int? fixedAmountCents;
  final String label;

  const SponsorDiscount({
    this.type = 'PERCENT',
    this.percent,
    this.maxPercent,
    this.fixedAmountCents,
    this.label = '',
  });

  factory SponsorDiscount.fromJson(Map<String, dynamic> json) =>
      SponsorDiscount(
        type: json['type'] as String? ?? 'PERCENT',
        percent: json['percent'] as int?,
        maxPercent: json['maxPercent'] as int?,
        fixedAmountCents: json['fixedAmountCents'] as int?,
        label: json['label'] as String? ?? '',
      );
}

class SponsorSpecial {
  final String id;
  final String businessName;
  final String? businessType;
  final String? businessDescription;
  final String? address;
  final String? city;
  final String? state;
  final double? latitude;
  final double? longitude;
  final String? logoUrl;
  final String? coverImageUrl;
  final String? googlePlaceId;
  final String? googleBusinessName;
  final String? googleBusinessCategory;
  final SponsorDiscount discount;
  final double? kmAway;
  final String status;

  const SponsorSpecial({
    required this.id,
    required this.businessName,
    this.businessType,
    this.businessDescription,
    this.address,
    this.city,
    this.state,
    this.latitude,
    this.longitude,
    this.logoUrl,
    this.coverImageUrl,
    this.googlePlaceId,
    this.googleBusinessName,
    this.googleBusinessCategory,
    required this.discount,
    this.kmAway,
    required this.status,
  });

  bool get isGoogleConnected =>
      googlePlaceId != null && googlePlaceId!.isNotEmpty;

  factory SponsorSpecial.fromJson(Map<String, dynamic> json) =>
      SponsorSpecial(
        id: json['id'] as String? ?? '',
        businessName: json['businessName'] as String? ?? '',
        businessType: json['businessType'] as String?,
        businessDescription: json['businessDescription'] as String?,
        address: json['address'] as String?,
        city: json['city'] as String?,
        state: json['state'] as String?,
        latitude: (json['latitude'] as num?)?.toDouble(),
        longitude: (json['longitude'] as num?)?.toDouble(),
        logoUrl: json['logoUrl'] as String?,
        coverImageUrl: json['coverImageUrl'] as String?,
        googlePlaceId: json['googlePlaceId'] as String?,
        googleBusinessName: json['googleBusinessName'] as String?,
        googleBusinessCategory: json['googleBusinessCategory'] as String?,
        discount: SponsorDiscount.fromJson(
            (json['discount'] as Map<String, dynamic>?) ?? const {}),
        kmAway: (json['kmAway'] as num?)?.toDouble(),
        status: json['status'] as String? ?? '',
      );
}

/// Redemption row as normalized by the backend (snake_case columns).
class SpecialRedemption {
  final String id;
  final String sponsorId;
  final String riderId;
  final String? driverId;
  final String? rideId;
  final String sponsorName;
  final String? sponsorBusinessType;
  final double? sponsorLatitude;
  final double? sponsorLongitude;
  final String? sponsorAddress;
  final String discountType;
  final int? discountPercent;
  final int? discountFixedAmountCents;
  final String discountLabel;
  final int calculatedDiscountCents;
  final DateTime? validationExpiresAt;
  final int validationAttempts;
  final int maxValidationAttempts;
  final String status;
  final DateTime? rideRequestedAt;
  final DateTime? rideCompletedAt;
  final DateTime? sponsorValidatedAt;
  final String? cancelledBy;
  final DateTime? cancelledAt;
  final String? cancellationReasonCode;
  final String? cancellationReasonText;
  final String? rewardChoice;
  final int? rewardAmountCents;
  final int? sponsorFundedCents;
  final int? driverAllocationCents;
  final int? netrideAllocationCents;
  final int? netrideBonusCents;
  final DateTime? rewardProcessedAt;
  final String? rewardFailedReason;
  final DateTime createdAt;
  final DateTime updatedAt;

  const SpecialRedemption({
    required this.id,
    required this.sponsorId,
    required this.riderId,
    this.driverId,
    this.rideId,
    required this.sponsorName,
    this.sponsorBusinessType,
    this.sponsorLatitude,
    this.sponsorLongitude,
    this.sponsorAddress,
    required this.discountType,
    this.discountPercent,
    this.discountFixedAmountCents,
    required this.discountLabel,
    required this.calculatedDiscountCents,
    this.validationExpiresAt,
    required this.validationAttempts,
    required this.maxValidationAttempts,
    required this.status,
    this.rideRequestedAt,
    this.rideCompletedAt,
    this.sponsorValidatedAt,
    this.cancelledBy,
    this.cancelledAt,
    this.cancellationReasonCode,
    this.cancellationReasonText,
    this.rewardChoice,
    this.rewardAmountCents,
    this.sponsorFundedCents,
    this.driverAllocationCents,
    this.netrideAllocationCents,
    this.netrideBonusCents,
    this.rewardProcessedAt,
    this.rewardFailedReason,
    required this.createdAt,
    required this.updatedAt,
  });

  bool get isActive => const [
        'CREATED',
        'RIDE_PENDING',
        'WAITING_FOR_SPONSOR',
        'SPONSOR_VALIDATED',
        'REWARD_SELECTED',
      ].contains(status);

  factory SpecialRedemption.fromJson(Map<String, dynamic> json) {
    DateTime? ts(String? raw) => DateTime.tryParse(raw ?? '');
    return SpecialRedemption(
      id: json['id'] as String? ?? '',
      sponsorId: json['sponsor_id'] as String? ?? '',
      riderId: json['rider_id'] as String? ?? '',
      driverId: json['driver_id'] as String?,
      rideId: json['ride_id'] as String?,
      sponsorName: json['sponsor_name'] as String? ?? '',
      sponsorBusinessType: json['sponsor_business_type'] as String?,
      sponsorLatitude: (json['sponsor_latitude'] as num?)?.toDouble(),
      sponsorLongitude: (json['sponsor_longitude'] as num?)?.toDouble(),
      sponsorAddress: json['sponsor_address'] as String?,
      discountType: json['discount_type'] as String? ?? 'PERCENT',
      discountPercent: json['discount_percent'] as int?,
      discountFixedAmountCents: json['discount_fixed_amount_cents'] as int?,
      discountLabel: json['discount_label'] as String? ?? '',
      calculatedDiscountCents: json['calculated_discount_cents'] as int? ?? 0,
      validationExpiresAt: ts(json['validation_expires_at'] as String?),
      validationAttempts: json['validation_attempts'] as int? ?? 0,
      maxValidationAttempts: json['max_validation_attempts'] as int? ?? 5,
      status: json['status'] as String? ?? '',
      rideRequestedAt: ts(json['ride_requested_at'] as String?),
      rideCompletedAt: ts(json['ride_completed_at'] as String?),
      sponsorValidatedAt: ts(json['sponsor_validated_at'] as String?),
      cancelledBy: json['cancelled_by'] as String?,
      cancelledAt: ts(json['cancelled_at'] as String?),
      cancellationReasonCode: json['cancellation_reason_code'] as String?,
      cancellationReasonText: json['cancellation_reason_text'] as String?,
      rewardChoice: json['reward_choice'] as String?,
      rewardAmountCents: json['reward_amount_cents'] as int?,
      sponsorFundedCents: json['sponsor_funded_cents'] as int?,
      driverAllocationCents: json['driver_allocation_cents'] as int?,
      netrideAllocationCents: json['netride_allocation_cents'] as int?,
      netrideBonusCents: json['netride_bonus_cents'] as int?,
      rewardProcessedAt: ts(json['reward_processed_at'] as String?),
      rewardFailedReason: json['reward_failed_reason'] as String?,
      createdAt: ts(json['created_at'] as String?) ?? DateTime.now(),
      updatedAt: ts(json['updated_at'] as String?) ?? DateTime.now(),
    );
  }
}

String formatCents2(int cents) {
  final dollars = cents / 100.0;
  final sign = dollars < 0 ? '-' : '';
  return '$sign\$${dollars.abs().toStringAsFixed(2)}';
}

/// Validation-code countdown label: hours only while >= 1h ("23h"), then
/// minutes only under 1h ("45m"). Seconds are never shown.
String validationCountdownLabel(DateTime expiresAt, {DateTime? now}) {
  final remaining = expiresAt.difference(now ?? DateTime.now());
  if (remaining <= Duration.zero) return 'Expired';
  if (remaining.inHours >= 1) return '${remaining.inHours}h';
  final minutes = (remaining.inSeconds / 60).ceil().clamp(1, 59);
  return '${minutes}m';
}
