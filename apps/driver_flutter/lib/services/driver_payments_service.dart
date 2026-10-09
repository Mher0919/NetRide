import 'api_service.dart';

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
    final response = await ApiService.dio.post('/payments/connect/onboarding');
    return (response.data as Map)['url'] as String;
  }
}