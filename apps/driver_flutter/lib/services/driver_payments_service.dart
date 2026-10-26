import 'package:dio/dio.dart';

import 'api_service.dart';

/// Safe, driver-facing failure from the payout onboarding endpoint.
class PayoutOnboardingException implements Exception {
  const PayoutOnboardingException(this.message, {this.code});

  final String message;
  final String? code;

  @override
  String toString() => code == null ? message : '$message ($code)';
}

/// Stripe Connect surface for drivers: onboarding status (server-verified)
/// and the hosted onboarding link. Transfers are initiated by NetRide using
/// the driver's connected account; this client never touches card/bank data.
class DriverPaymentsService {
  /// Server-verified Connect account state (payout readiness = Stripe's
  /// `payouts_enabled`, never "the driver finished the form").
  static Future<Map<String, dynamic>> getConnectStatus(
      {bool sync = false}) async {
    final response = await ApiService.dio
        .get('/payments/connect/status', queryParameters: sync ? {'sync': 'true'} : null);
    return Map<String, dynamic>.from(response.data as Map);
  }

  /// Returns the Stripe-hosted onboarding URL (single use, short lived).
  static Future<String> startOnboarding() async {
    try {
      final response = await ApiService.dio.post('/payments/connect/onboarding');
      final data = response.data;
      final url = data is Map ? data['url'] : null;
      if (url is! String || url.isEmpty) {
        throw const PayoutOnboardingException(
          'Payout setup is not available right now. Please try again later.',
          code: 'missing_onboarding_url',
        );
      }
      return url;
    } on DioException catch (e) {
      final data = e.response?.data;
      String? message;
      String? code;
      if (data is Map) {
        final rawMessage = data['error'];
        final rawCode = data['code'];
        if (rawMessage is String && rawMessage.trim().isNotEmpty) {
          message = rawMessage.trim();
        }
        if (rawCode is String && rawCode.trim().isNotEmpty) {
          code = rawCode.trim();
        }
      }
      throw PayoutOnboardingException(
        message ?? 'Payout setup is not available right now. Please try again later.',
        code: code,
      );
    }
  }
}
