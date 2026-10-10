// lib/services/payments_service.dart
//
// Stripe payment surface for the rider app. All financial decisions stay
// server-side; card entry happens inside the app through Stripe's native
// PaymentSheet (the backend issues a SetupIntent client_secret + an
// ephemeral key scoped to this rider's Stripe Customer).

import 'package:intl/intl.dart';
import 'api_service.dart';

class PaymentProfile {
  final bool configured;
  final String mode;
  final String? cardBrand;
  final String? cardLast4;
  final int? cardExpMonth;
  final int? cardExpYear;
  final bool offSessionConsent;

  const PaymentProfile({
    required this.configured,
    required this.mode,
    this.cardBrand,
    this.cardLast4,
    this.cardExpMonth,
    this.cardExpYear,
    required this.offSessionConsent,
  });

  bool get hasCard => cardLast4 != null;

  String get cardLabel {
    final brand = (cardBrand ?? '').isNotEmpty
        ? cardBrand!.toUpperCase()
        : 'Card';
    final exp = (cardExpMonth != null && cardExpYear != null)
        ? ' ${cardExpMonth!.toString().padLeft(2, '0')}/${cardExpYear! % 100}'
        : '';
    return hasCard ? '$brand ••••$cardLast4$exp' : 'No card on file';
  }

  factory PaymentProfile.fromJson(Map<String, dynamic> json) {
    final card = json['card'] as Map<String, dynamic>?;
    return PaymentProfile(
      configured: json['configured'] as bool? ?? false,
      mode: json['mode'] as String? ?? 'unconfigured',
      cardBrand: card?['brand'] as String?,
      cardLast4: card?['last4'] as String?,
      cardExpMonth: card?['exp_month'] as int?,
      cardExpYear: card?['exp_year'] as int?,
      offSessionConsent: json['off_session_consent'] as bool? ?? false,
    );
  }
}

/// Non-sensitive metadata for one saved payment method.
class SavedPaymentMethod {
  final String id;
  final String? brand;
  final String? last4;
  final int? expMonth;
  final int? expYear;
  final bool isDefault;

  const SavedPaymentMethod({
    required this.id,
    this.brand,
    this.last4,
    this.expMonth,
    this.expYear,
    required this.isDefault,
  });

  String get label {
    final b = (brand ?? '').isNotEmpty ? brand!.toUpperCase() : 'Card';
    final exp = (expMonth != null && expYear != null)
        ? ' ${expMonth!.toString().padLeft(2, '0')}/${expYear! % 100}'
        : '';
    return '$b ••••$last4$exp';
  }

  factory SavedPaymentMethod.fromJson(Map<String, dynamic> json) {
    return SavedPaymentMethod(
      id: json['id'] as String,
      brand: json['brand'] as String?,
      last4: json['last4'] as String?,
      expMonth: json['exp_month'] as int?,
      expYear: json['exp_year'] as int?,
      isDefault: json['isDefault'] as bool? ?? false,
    );
  }
}

/// Server response for POST /payments/setup-intent (PaymentSheet inputs).
class PaymentSheetInit {
  final String setupIntentId;
  final String setupIntentClientSecret;
  final String ephemeralKey;
  final String customerId;
  final String? publishableKey;
  final String mode;

  const PaymentSheetInit({
    required this.setupIntentId,
    required this.setupIntentClientSecret,
    required this.ephemeralKey,
    required this.customerId,
    this.publishableKey,
    required this.mode,
  });

  factory PaymentSheetInit.fromJson(Map<String, dynamic> json) {
    return PaymentSheetInit(
      setupIntentId: json['setupIntentId'] as String,
      setupIntentClientSecret: json['setupIntentClientSecret'] as String,
      ephemeralKey: json['ephemeralKey'] as String,
      customerId: json['customerId'] as String,
      publishableKey: json['publishableKey'] as String?,
      mode: json['mode'] as String? ?? 'unconfigured',
    );
  }
}

class RidePaymentStatus {
  final String rideStatus;
  final String? settlementStatus;
  final String? additionalChargeStatus;
  final String? sponsorContributionStatus;
  final int? originalFareCents;
  final int? riderCollectedCents;
  final int? additionalRiderChargeCents;

  const RidePaymentStatus({
    required this.rideStatus,
    this.settlementStatus,
    this.additionalChargeStatus,
    this.sponsorContributionStatus,
    this.originalFareCents,
    this.riderCollectedCents,
    this.additionalRiderChargeCents,
  });

  factory RidePaymentStatus.fromJson(Map<String, dynamic> json) {
    final b = json['breakdown'] as Map<String, dynamic>?;
    return RidePaymentStatus(
      rideStatus: json['rideStatus'] as String? ?? '',
      settlementStatus: b?['settlementStatus'] as String?,
      additionalChargeStatus: b?['additionalChargeStatus'] as String?,
      sponsorContributionStatus: b?['sponsorContributionStatus'] as String?,
      originalFareCents: b?['originalFareCents'] as int?,
      riderCollectedCents: b?['riderCollectedCents'] as int?,
      additionalRiderChargeCents: b?['additionalRiderChargeCents'] as int?,
    );
  }
}

class PaymentsService {
  static final _fmt = NumberFormat.currency(symbol: r'$');

  /// Non-secret Stripe configuration for the authenticated rider.
  static Future<Map<String, dynamic>> getConfig() async {
    final res = await ApiService.dio.get('/payments/config');
    return Map<String, dynamic>.from(res.data as Map);
  }

  /// Server-verified payment profile (saved card, consent, mode).
  static Future<PaymentProfile> getProfile() async {
    final res = await ApiService.dio.get('/payments/profile');
    return PaymentProfile.fromJson(res.data as Map<String, dynamic>);
  }

  /// Asks the backend for a SetupIntent + ephemeral key so the rider can
  /// enter their card inside the app via Stripe's PaymentSheet.
  static Future<PaymentSheetInit> createSetupIntent({bool consent = true}) async {
    final res = await ApiService.dio.post('/payments/setup-intent', data: {
      'consent': consent,
    });
    return PaymentSheetInit.fromJson(res.data as Map<String, dynamic>);
  }

  /// Server-side confirmation of the completed SetupIntent (idempotent; the
  /// webhook is the durable source of truth).
  static Future<void> confirmSetupIntent(String setupIntentId) async {
    await ApiService.dio.post('/payments/setup-intent/confirm', data: {
      'setupIntentId': setupIntentId,
    });
  }

  /// Saved payment methods (brand/last4/expiry + default flag).
  static Future<List<SavedPaymentMethod>> listMethods() async {
    final res = await ApiService.dio.get('/payments/methods');
    final list = (res.data as Map<String, dynamic>)['methods'] as List? ?? [];
    return list
        .map((m) => SavedPaymentMethod.fromJson(m as Map<String, dynamic>))
        .toList();
  }

  /// Sets the default saved card.
  static Future<void> setDefaultMethod(String id) async {
    await ApiService.dio.post('/payments/methods/$id/default');
  }

  /// Removes an eligible saved card (the default cannot be removed).
  static Future<void> removeMethod(String id) async {
    await ApiService.dio.delete('/payments/methods/$id');
  }

  /// Server-verified payment state for one of the rider's rides.
  static Future<RidePaymentStatus> getRidePaymentStatus(String rideId) async {
    final res = await ApiService.dio.get('/payments/ride/$rideId/status');
    return RidePaymentStatus.fromJson(res.data as Map<String, dynamic>);
  }

  /// Explicit off-session charge consent record (server-side timestamp).
  static Future<void> recordConsent() async {
    await ApiService.dio.post('/payments/consent');
  }

  static String fmtCents(int? cents) =>
      cents == null ? '—' : _fmt.format(cents / 100);
}