/// Centralized, typed cache key constants.
///
/// Every cacheable data category has a scoped key function that accepts
/// the authenticated driver ID. This guarantees:
///   - predictable key strings (no typos across files)
///   - driver-scoped isolation
///   - easy invalidation from mutations and socket events
///
/// Format: `{category}:{driverId}` for most keys.
/// Compound keys append a sub-type (e.g. `documents:reqs:{driverId}`).
class CacheKeys {
  CacheKeys._();

  // ── CLASS A — Low-frequency profile data ──────────────────────────

  static String driverProfile(String driverId) =>
      'profile:driver:$driverId';

  static String driverProfilePicture(String driverId) =>
      'profile:picture:$driverId';

  static String driverVehicle(String driverId) =>
      'vehicle:active:$driverId';

  static String driverLicense(String driverId) =>
      'license:driver:$driverId';

  // ── CLASS B — Workflow / status data ─────────────────────────────

  static String driverVerificationStatus(String driverId) =>
      'status:verification:$driverId';

  static String driverDocumentRequirements(String driverId) =>
      'documents:requirements:$driverId';

  static String driverVehicleSubmissions(String driverId) =>
      'vehicle:submissions:$driverId';

  static String driverEligibility(String driverId) =>
      'status:eligibility:$driverId';

  static String driverProfileChange(String driverId) =>
      'profile:change:$driverId';

  static String driverPricing(String driverId) =>
      'pricing:driver:$driverId';

  static String driverPayoutCard(String driverId) =>
      'wallet:payout_card:$driverId';

  static String driverWallet(String driverId) =>
      'wallet:balance:$driverId';

  static String driverPayouts(String driverId) =>
      'wallet:payouts:$driverId';

  // ── CLASS C — Operational data (not cached, but listed for completeness) ──

  static String driverOnlineState(String driverId) =>
      'state:online:$driverId';

  static String currentTrip(String driverId) =>
      'trip:current:$driverId';

  static String riderLocation(String tripId) =>
      'location:rider:$tripId';

  // ── Helpers ──────────────────────────────────────────────────────

  /// Returns every cache key that should be cleared on logout.
  static List<String> allKeysForUser(String driverId) => [
        driverProfile(driverId),
        driverProfilePicture(driverId),
        driverVehicle(driverId),
        driverLicense(driverId),
        driverVerificationStatus(driverId),
        driverDocumentRequirements(driverId),
        driverVehicleSubmissions(driverId),
        driverEligibility(driverId),
        driverProfileChange(driverId),
        driverPricing(driverId),
        driverPayoutCard(driverId),
        driverWallet(driverId),
        driverPayouts(driverId),
      ];
}
