// lib/services/payments_service.dart
//
// Stripe payment surface for the rider app. All financial decisions stay
// server-side; these endpoints only open Stripe-hosted Checkout pages and
// read server-verified payment state.

import 'package:dio/dio.dart';
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

  /// Server-verified payment profile (saved card, consent, mode).
  static Future<PaymentProfile> getProfile() async {
    final res = await ApiService.dio.get('/payments/profile');
    return PaymentProfile.fromJson(res.data as Map<String, dynamic>);
  }

  /// Opens Stripe-hosted Checkout to save a card (consent included).
  /// Returns the checkout URL; the rider completes it in the browser.
  static Future<String> startCardSetup({bool consent = true}) async {
    final res = await ApiService.dio.post('/payments/setup-session', data: {
      'consent': consent,
    });
    return (res.data as Map<String, dynamic>)['url'] as String;
  }

  /// Stripe-hosted Checkout to add funds to the wallet.
  static Future<String> startWalletTopUp(int amountCents) async {
    final res = await ApiService.dio.post('/payments/wallet/topup-session', data: {
      'amountCents': amountCents,
    });
    return (res.data as Map<String, dynamic>)['url'] as String;
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