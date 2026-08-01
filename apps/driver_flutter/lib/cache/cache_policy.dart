/// Caching policy for each data classification category.
///
/// Every cacheable data category is assigned a specific
/// [CachePolicy] that defines:
///   - `staleDuration`: how long the data is considered fresh
///   - `ttl`: maximum lifetime before the entry is evicted
///   - `persist`: whether the data survives app restarts
///
/// After `staleDuration`, the data is still returned immediately
/// (cache-first) but a background revalidation should be triggered.
/// After `ttl` expires, the entry is treated as expired and the
/// next read will bypass the cache entirely.
enum CachePolicy {
  // ── CLASS A — Low-frequency profile data ──────────────────────────
  // Persisted across restarts. Fresh for 5 minutes, stale but
  // usable for 30 minutes. After 30 min, force a full refresh.
  profile(
    staleDuration: Duration(minutes: 5),
    ttl: Duration(minutes: 30),
    persist: true,
  ),

  // Profile picture reference (canonical storage path).
  // Longer stale since images change very rarely.
  profilePicture(
    staleDuration: Duration(minutes: 15),
    ttl: Duration(hours: 2),
    persist: true,
  ),

  // Vehicle metadata (make/model/year/color/plate). Changes only
  // through admin approval queue. Persisted for cold starts.
  vehicle(
    staleDuration: Duration(minutes: 5),
    ttl: Duration(hours: 1),
    persist: true,
  ),

  // License info. Rarely changes. Persisted.
  license(
    staleDuration: Duration(minutes: 5),
    ttl: Duration(hours: 1),
    persist: true,
  ),

  // ── CLASS B — Workflow / status data ─────────────────────────────
  // Shorter stale times. NOT persisted — always fresh on cold start.
  // Revalidated on app foreground.

  // Verification status, background check status, rejection reason.
  verificationStatus(
    staleDuration: Duration(seconds: 30),
    ttl: Duration(minutes: 5),
    persist: false,
  ),

  // Document requirement status (action-required cards).
  // Short TTL because these drive the main status page and change
  // via admin actions + Socket.IO events.
  documentRequirements(
    staleDuration: Duration(seconds: 15),
    ttl: Duration(minutes: 2),
    persist: false,
  ),

  // Vehicle inspection/submission status.
  vehicleSubmission(
    staleDuration: Duration(seconds: 30),
    ttl: Duration(minutes: 5),
    persist: false,
  ),

  // Driver eligibility composite state.
  eligibility(
    staleDuration: Duration(seconds: 30),
    ttl: Duration(minutes: 3),
    persist: false,
  ),

  // Profile change pending state.
  profileChange(
    staleDuration: Duration(seconds: 15),
    ttl: Duration(minutes: 2),
    persist: false,
  ),

  // ── CLASS B (semi-dynamic) — Wallet ──────────────────────────────
  wallet(
    staleDuration: Duration(seconds: 30),
    ttl: Duration(minutes: 5),
    persist: false,
  ),

  payouts(
    staleDuration: Duration(minutes: 1),
    ttl: Duration(minutes: 10),
    persist: false,
  ),

  // ── CLASS C — Not cached via this system ─────────────────────────
  // Operational data (trip state, location, socket events) is
  // handled by the DriverProvider and Socket.IO directly.
  // This entry exists as a sentinel only.
  operational(
    staleDuration: Duration.zero,
    ttl: Duration.zero,
    persist: false,
  );

  final Duration staleDuration;
  final Duration ttl;
  final bool persist;

  const CachePolicy({
    required this.staleDuration,
    required this.ttl,
    required this.persist,
  });

  bool get shouldRevalidate =>
      staleDuration != Duration.zero || ttl != Duration.zero;
}
