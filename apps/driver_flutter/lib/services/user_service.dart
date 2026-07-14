import 'api_service.dart';

/// Driver-side helpers for the user / profile / wallet / payout surface.
///
/// All edits go through `submitProfileChange` (admin approval queue) —
/// `updateProfile` is retained for legacy callers but should not be used
/// for sensitive fields.
class UserService {
  // ---- Profile ------------------------------------------------------------

  static Future<Map<String, dynamic>> getProfile() async {
    try {
      final response = await ApiService.dio.get('/driver/profile');
      return (response.data is Map)
          ? Map<String, dynamic>.from(response.data as Map)
          : <String, dynamic>{};
    } catch (e) {
      rethrow;
    }
  }

  /// Legacy direct PATCH — kept for backward compatibility. New flows
  /// should use `submitProfileChange` instead so the change goes through
  /// the admin approval queue.
  static Future<void> updateProfile(Map<String, dynamic> data) async {
    try {
      await ApiService.dio.patch('/driver/profile', data: data);
    } catch (e) {
      rethrow;
    }
  }

  static Future<List<dynamic>> getVehicles() async {
    try {
      final response = await ApiService.dio.get('/driver/vehicles');
      return response.data is List
          ? List<dynamic>.from(response.data as List)
          : <dynamic>[];
    } catch (e) {
      rethrow;
    }
  }

  // ---- Profile-change approval queue --------------------------------------

  /// Submits a diff of proposed edits to the admin queue. The driver's
  /// `is_active` is set to false server-side until the change is approved
  /// or rejected. Returns the new request summary on success.
  ///
  /// Throws an Exception whose `.toString()` includes the backend error
  /// code (e.g. "PROFILE_CHANGE_PENDING", "RATE_LIMITED",
  /// "PHONE_NOT_VERIFIED") — callers should map these to UI messages.
  static Future<Map<String, dynamic>> submitProfileChange(
      Map<String, dynamic> changes) async {
    try {
      final response = await ApiService.dio.post(
        '/driver/profile-changes',
        data: {'changes': changes},
      );
      return (response.data is Map)
          ? Map<String, dynamic>.from(response.data as Map)
          : <String, dynamic>{};
    } catch (e) {
      rethrow;
    }
  }

  /// Returns the latest request (any status) the driver submitted, or null
  /// when none exists.
  static Future<Map<String, dynamic>?> getCurrentProfileChange() async {
    try {
      final response = await ApiService.dio.get(
        '/driver/profile-changes/current',
      );
      if (response.data == null) return null;
      if (response.data is Map) {
        final m = Map<String, dynamic>.from(response.data as Map);
        return m.isEmpty ? null : m;
      }
      return null;
    } catch (e) {
      rethrow;
    }
  }

  // ---- Wallet + payout cards ---------------------------------------------

  /// Returns a wallet summary including balance, lifetime earnings, the
  /// currently-approved payout card (masked), and the 5 most recent
  /// payouts.
  static Future<Map<String, dynamic>> getWallet() async {
    try {
      final response = await ApiService.dio.get('/driver/wallet');
      return (response.data is Map)
          ? Map<String, dynamic>.from(response.data as Map)
          : <String, dynamic>{};
    } catch (e) {
      rethrow;
    }
  }

  /// Submits a payout card for admin approval. The server Luhn-validates
  /// the PAN and discards it immediately; only last4/brand/exp/name/zip
  /// are stored. CVC is discarded after validation.
  static Future<Map<String, dynamic>> addPayoutCard(
      Map<String, dynamic> card) async {
    try {
      final response = await ApiService.dio.post(
        '/driver/payout-cards',
        data: card,
      );
      return (response.data is Map)
          ? Map<String, dynamic>.from(response.data as Map)
          : <String, dynamic>{};
    } catch (e) {
      rethrow;
    }
  }

  /// Requests an on-demand payout of `amountCents` to the driver's
  /// approved payout card. Server debits the wallet and inserts a PENDING
  /// ON_DEMAND payout (5% fee).
  static Future<Map<String, dynamic>> requestOnDemandPayout(
      int amountCents) async {
    try {
      final response = await ApiService.dio.post(
        '/driver/wallet/request-payout',
        data: {'amount_cents': amountCents},
      );
      return (response.data is Map)
          ? Map<String, dynamic>.from(response.data as Map)
          : <String, dynamic>{};
    } catch (e) {
      rethrow;
    }
  }

  static Future<List<dynamic>> listMyPayouts({int limit = 20}) async {
    try {
      final response = await ApiService.dio.get(
        '/driver/payouts',
        queryParameters: {'limit': limit},
      );
      return response.data is List
          ? List<dynamic>.from(response.data as List)
          : <dynamic>[];
    } catch (e) {
      rethrow;
    }
  }

  // ---- Document requirements + resubmission --------------------------------

  static Future<Map<String, dynamic>> getDocumentRequirements() async {
    try {
      final response =
          await ApiService.dio.get('/driver/documents/requirements');
      return (response.data is Map)
          ? Map<String, dynamic>.from(response.data as Map)
          : <String, dynamic>{};
    } catch (e) {
      rethrow;
    }
  }

  static Future<Map<String, dynamic>> resubmitDocument(
      String requirementId, String newDocumentUrl) async {
    try {
      final response = await ApiService.dio.post(
        '/driver/documents/resubmit',
        data: {
          'requirementId': requirementId,
          'newDocumentUrl': newDocumentUrl,
        },
      );
      return (response.data is Map)
          ? Map<String, dynamic>.from(response.data as Map)
          : <String, dynamic>{};
    } catch (e) {
      rethrow;
    }
  }

  // ============================================================
  // New vehicle submission (025)
  // ============================================================

  static Future<Map<String, dynamic>> submitNewVehicle(
      Map<String, dynamic> data) async {
    try {
      final response = await ApiService.dio.post(
        '/driver/vehicles/submit',
        data: data,
      );
      return (response.data is Map)
          ? Map<String, dynamic>.from(response.data as Map)
          : <String, dynamic>{};
    } catch (e) {
      rethrow;
    }
  }

  static Future<Map<String, dynamic>> getPendingVehicleSubmissions() async {
    try {
      final response =
          await ApiService.dio.get('/driver/vehicles/submissions/pending');
      return (response.data is Map)
          ? Map<String, dynamic>.from(response.data as Map)
          : <String, dynamic>{};
    } catch (e) {
      rethrow;
    }
  }
}