// lib/providers/specials_provider.dart
//
// Rider-side SPECIALS state: discovery list + count badge, the intro gate,
// and the rider's resumable redemption. Subscribes to the RideProvider's
// socket relay so live transitions (code issued → sponsor validated →
// reward processed) re-render the card without polling.

import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import '../models/google_business.dart';
import '../models/special_models.dart';
import '../services/business_place_service.dart';
import '../services/specials_service.dart';
import 'ride_provider.dart';

class SpecialsProvider extends ChangeNotifier {
  SpecialsProvider({RideProvider? ride}) {
    _ride = ride;
    _ride?.specialRedemptionUpdates.listen((update) {
      _onRedemptionUpdate(update);
    });
    _ride?.notificationPing.listen((_) => refresh());
  }

  RideProvider? _ride;

  List<SponsorSpecial> _sponsors = [];
  List<SponsorSpecial> get sponsors => _sponsors;

  /// Open validation cards — one per completed special ride awaiting the
  /// sponsor's code entry (WAITING_FOR_SPONSOR) or awaiting the reward
  /// choice (SPONSOR_VALIDATED / REWARD_SELECTED / REWARD_FAILED). Renders
  /// the Explore "SPECIAL CODES" section; newest first.
  List<SpecialRedemption> _pending = [];
  List<SpecialRedemption> get pending => _pending;

  /// Cards whose one-time code was delivered live (socket) or recovered
  /// from notification history. The raw code is never persisted (spec §99).
  final Map<String, String> _codes = {};
  String? codeFor(String redemptionId) => _codes[redemptionId];
  void stashCodeFor(String redemptionId, String code) {
    if (redemptionId.isEmpty || code.isEmpty) return;
    _codes[redemptionId] = code;
  }

  /// Queued "your special code is ready" notices (ride completed). The
  /// active screen consumes exactly one per redemption so the full code
  /// card pops right after the ride ends without re-popping on rebuilds.
  final List<String> _readyQueue = [];
  String? consumeReadyNotice() =>
      _readyQueue.isNotEmpty ? _readyQueue.removeAt(0) : null;

  /// Queued "the business validated your visit" notices (SPONSOR_VALIDATED).
  /// Consumed by Explore to pop the congratulations + reward-choice dialog.
  final List<String> _rewardQueue = [];
  String? consumeRewardNotice() =>
      _rewardQueue.isNotEmpty ? _rewardQueue.removeAt(0) : null;

  /// Live redemption transition pushed by the backend (code issued →
  /// sponsor validated → reward processed). Stashes the one-time code when
  /// the ride completes and queues the "pop a dialog" notices.
  void _onRedemptionUpdate(Map<String, dynamic> update) {
    final id = update['id']?.toString();
    final status = update['status']?.toString();
    if (id == null || id.isEmpty) return;
    final code = update['code']?.toString();
    if (code != null && code.isNotEmpty) {
      stashCodeFor(id, code);
      if (status == 'WAITING_FOR_SPONSOR') {
        _readyQueue.add(id);
      }
    }
    if (status == 'SPONSOR_VALIDATED' || status == 'REWARD_SELECTED') {
      _rewardQueue.add(id);
    }
    refresh();
  }

  int _count = 0;
  int get count => _count;

  bool _loaded = false;
  bool get loaded => _loaded;

  bool _loading = false;
  bool get loading => _loading;

  String? _error;
  String? get error => _error;

  bool _introSeen = false;
  bool get introSeen => _introSeen;

  bool _introChecked = false;

  SpecialRedemption? _current;
  SpecialRedemption? get current => _current;

  bool _busy = false;
  bool get busy => _busy;

  /// Snapshot of the code delivered by the last push (`special_reward_ready`).
  /// The raw code is never persisted anywhere client-side (spec §99).
  String? _lastCode;
  String? get lastCode => _lastCode;
  void stashCode(String? code) {
    _lastCode = code;
  }

  /// Last known rider position (km-ordered discovery). Once set, EVERY
  /// refresh keeps using it so the Explore SPECIALS section and the map
  /// sponsor markers always read the same eligible list (same query, same
  /// ordering — no drift between the two surfaces).
  double? _geoLat;
  double? _geoLng;

  /// Full refresh: count + discovery + intro state + resumable redemption.
  /// When [lat]/[lng] are provided they become the persistent geo origin.
  ///
  /// The validation-code cards load SEPARATELY (see [_loadPendingCodes]):
  /// a failure there (e.g. an older backend without the /pending route)
  /// must NEVER take down the core SPECIALS section — the critical list is
  /// the eligible sponsors.
  Future<void> refresh({double? lat, double? lng}) async {
    if (lat != null && lng != null) {
      _geoLat = lat;
      _geoLng = lng;
    }
    _loading = true;
    _error = null;
    notifyListeners();
    try {
      final results = await Future.wait([
        SpecialsService.list(lat: _geoLat, lng: _geoLng),
        SpecialsService.count(),
        _introChecked
            ? Future.value(_introSeen)
            : SpecialsService.introSeen(),
        SpecialsService.currentRedemption(),
      ]);
      _sponsors = results[0] as List<SponsorSpecial>;
      _count = results[1] as int;
      if (!_introChecked) {
        _introSeen = results[2] as bool;
        _introChecked = true;
      }
      _current = results[3] as SpecialRedemption?;
      _loaded = true;
    } catch (e) {
      _error = '$e';
    } finally {
      _loading = false;
      notifyListeners();
      _loadPendingCodes();
    }
  }

  /// Loads the open validation-code cards independently of the core
  /// refresh. Non-fatal: on any failure (older backend, transient error)
  /// the section simply stays hidden and retries on the next refresh.
  Future<void> _loadPendingCodes() async {
    try {
      _pending = await SpecialsService.pendingRedemptions();
      notifyListeners();
    } catch (_) {
      _pending = [];
    }
    _recoverPendingCodes();
  }

  /// Backfills the one-time codes for pending cards that arrived without a
  /// live socket delivery (app restart, backgrounded completion). Reads the
  /// rider's own notification history; best-effort and non-blocking.
  Future<void> _recoverPendingCodes() async {
    for (final r in _pending) {
      if (r.status != 'WAITING_FOR_SPONSOR') continue;
      if (_codes.containsKey(r.id)) continue;
      try {
        final code = await SpecialsService.recoverCode(r.id);
        if (code != null && code.isNotEmpty) {
          stashCodeFor(r.id, code);
          notifyListeners();
        }
      } catch (_) {
        // Best-effort — the code can also be recovered on the card screen.
      }
    }
  }

  /// Lightweight count-only refresh (tab badge). Never shows a spinner.
  Future<void> refreshCount() async {
    try {
      _count = await SpecialsService.count();
      notifyListeners();
    } catch (_) {}
  }

  Future<void> acknowledgeIntro() async {
    try {
      await SpecialsService.markIntroSeen();
      _introSeen = true;
      notifyListeners();
    } catch (_) {}
  }

  /// Step 1 — pick a sponsor. Throws the backend's error string on failure.
  Future<SpecialRedemption> pickSponsor(String sponsorId) async {
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      final redemption = await SpecialsService.createRedemption(sponsorId);
      _current = redemption;
      await refreshCount();
      return redemption;
    } catch (e) {
      _error = friendlyFrom(e);
      rethrow;
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// Step 4 — rider was verified at the business.
  Future<void> markVerified() async {
    final r = _current;
    if (r == null) return;
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      _current = await SpecialsService.markVerified(r.id);
    } catch (e) {
      _error = friendlyFrom(e);
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// Step 5 — reward choice (REFUND | CREDITS), server-confirmed.
  Future<SpecialRedemption?> chooseReward(String choice) async {
    final r = _current;
    if (r == null) return null;
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      final redemption = await SpecialsService.chooseReward(
        r.id,
        choice,
        confirmed: true,
      );
      _current = redemption;
      return redemption;
    } catch (e) {
      _error = friendlyFrom(e);
      return null;
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// Called once on app start / login to resync the resumable redemption.
  Future<void> loadCurrent() async {
    try {
      _current = await SpecialsService.currentRedemption();
      notifyListeners();
    } catch (_) {}
    _loadPendingCodes();
  }

  /// True while the rider may attach this redemption to a new ride.
  bool get canAttachToRide {
    final r = _current;
    return r != null && r.status == 'CREATED';
  }

  // ================================================================
  // SELECTED SPECIAL — the single source of truth (spec §30)
  //
  // `selectedSpecialId` drives the red map marker, the highlighted Special
  // card and the business bottom sheet. There is never independent selection
  // state in the map, the card or the sheet.
  // ================================================================

  String? _selectedSpecialId;
  String? get selectedSpecialId => _selectedSpecialId;

  void selectSpecial(String id) {
    if (id.isEmpty || _selectedSpecialId == id) return;
    _selectedSpecialId = id;
    notifyListeners();
  }

  void clearSelection() {
    if (_selectedSpecialId == null) return;
    _selectedSpecialId = null;
    notifyListeners();
  }

  // ================================================================
  // GOOGLE BUSINESS DATA (server-proxied Places API)
  // ================================================================

  final Map<String, GoogleBusinessResult> _businessBySpecial = {};
  final Map<String, bool> _businessLoading = {};
  final Map<String, bool> _businessFullRequested = {};
  final Set<String> _photoHydrationRequested = {};

  /// Cached Google business for a Special, or null while unknown.
  GoogleBusinessResult? businessFor(String sponsorId) =>
      _businessBySpecial[sponsorId];
  bool businessLoading(String sponsorId) =>
      _businessLoading[sponsorId] == true;

  /// Loads Google business info for a Special (deduped per request level).
  /// Never throws — a failure is cached as an "unavailable" result so the
  /// sheet can render the admin Special with a graceful notice.
  Future<GoogleBusinessResult?> ensureBusiness(
    String sponsorId, {
    String level = 'basic',
    bool force = false,
  }) async {
    if (sponsorId.isEmpty) return null;
    final existing = _businessBySpecial[sponsorId];
    if (!force && existing != null) {
      final satisfied = existing.manual ||
          (existing.business != null &&
              (level == 'basic' || existing.business!.isFull));
      if (satisfied || _businessLoading[sponsorId] == true) return existing;
    }
    if (_businessLoading[sponsorId] == true) return existing;

    // A previous failure (no business, not manual) should be retried rather
    // than served from the client cache.
    final retryAfterFailure =
        existing != null && existing.business == null && !existing.manual;

    _businessLoading[sponsorId] = true;
    notifyListeners();
    try {
      final result = await BusinessPlaceService.fetchForSpecial(
        sponsorId,
        level: level,
        force: force || retryAfterFailure,
      );
      _businessBySpecial[sponsorId] = result;
      return result;
    } catch (e) {
      debugPrint('[SPECIALS] business fetch failed for $sponsorId: $e');
      if (existing == null) {
        _businessBySpecial[sponsorId] = GoogleBusinessResult.unavailable;
      }
      return _businessBySpecial[sponsorId];
    } finally {
      _businessLoading[sponsorId] = false;
      notifyListeners();
    }
  }

  /// Upgrades a Special's Google info to `full` (hours, phone, website,
  /// reviews) exactly once — used when the bottom sheet is expanded.
  Future<void> ensureFullBusiness(String sponsorId) async {
    if (_businessFullRequested[sponsorId] == true) return;
    _businessFullRequested[sponsorId] = true;
    final current = _businessBySpecial[sponsorId];
    if (current?.manual == true) return;
    if (current?.business?.isFull == true) return;
    await ensureBusiness(sponsorId, level: 'full', force: true);
  }

  /// Warms the basic Google photo for the visible Special cards so the
  /// redesigned cards can use real business imagery (spec §12). Best-effort,
  /// at most one request per Special per session, and only for cards that
  /// have no admin-provided cover image.
  void hydrateCardPhotos(Iterable<SponsorSpecial> sponsors) {
    var started = 0;
    for (final s in sponsors) {
      if (started >= 5) break;
      if (!s.isGoogleConnected) continue;
      if (s.coverImageUrl?.isNotEmpty == true) continue;
      if (_photoHydrationRequested.contains(s.id)) continue;
      if (_businessBySpecial.containsKey(s.id) ||
          _businessLoading[s.id] == true) {
        continue;
      }
      _photoHydrationRequested.add(s.id);
      started++;
      ensureBusiness(s.id);
    }
  }

  String friendlyFrom(Object e) {
    if (e is DioException) return SpecialsService.friendlyError(e);
    return 'Something went wrong. Please try again.';
  }
}
