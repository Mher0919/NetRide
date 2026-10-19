import 'dart:async';
import '../services/secure_token_store.dart';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import '../models/trip_models.dart' as models;
import '../services/api_service.dart';
import '../services/user_service.dart';
import '../services/sound_service.dart';
import '../services/notification_service.dart';
import '../components/tip_received_dialog.dart';
import '../cache/cache_service.dart';
import '../cache/cache_keys.dart';
import '../cache/cache_policy.dart';
import '../cache/user_cache_repository.dart';

/// Ordered compliance status for the driver's current blocker (if any).
/// Priority decreases from top to bottom.
enum DriverComplianceStatus {
  profileChangePending,
  profileChangeApproved,
  backgroundCheckRejected,
  backgroundCheckPending,
  backgroundCheckApproved,
  documentActionRequired,
  vehicleInspectionRequired,
  documentSubmitted,
  headshotActionRequired,
}

class DriverProvider with ChangeNotifier {
  models.DriverStatus _status = models.DriverStatus.offline;

  models.Trip? _currentTrip;
  models.Trip? _incomingRequest;
  IO.Socket? _socket;
  bool _isConnected = false;
  models.Location? _lastLocation;
  double _heading = 0;
  models.Location? _riderLocation;
  List<models.ChatMessage> _messages = [];

  /// First-class cancelled state: the terminal trip (with cancelled_by +
  /// reason) is kept until the UI acknowledges it (ackCancelled), so the
  /// driver sees "Ride cancelled / who / why" instead of a null ride.
  models.Trip? _lastCancelledTrip;

  /// The authoritative COMPLETED trip payload (server-attached
  /// `driver_earnings_cents` included), kept briefly so the completion
  /// dialog shows the real take-home instead of falling back to the gross
  /// rider fare. Cleared when the next ride context begins.
  models.Trip? _lastCompletedTrip;

  /// True when the driver's own cancel emit could not be confirmed by the
  /// server within the fallback window (offline / socket error). The UI
  /// shows this as "cancellation request failed / connection lost".
  bool _cancelConfirmFailed = false;

  /// Human-readable reason the last cancellation failed (rejected by the
  /// server, or connection lost before confirmation).
  String? _lastCancelError;

  /// Trip ids that reached a terminal state (COMPLETED / CANCELLED).
  /// Delayed duplicate socket updates for these rides — retries, event
  /// ordering races, reconnects — must NEVER resurrect the active ride
  /// (which would re-push the trip screen and yank the driver out of
  /// chat/cancel flows).
  final Set<String> _settledTripIds = {};

  /// Server-confirmed availability (lease) state. `_status` is the local
  /// intent; `_serverOnline` is what the backend actually holds. The two
  /// must be reconciled on every connect instead of trusting a local flag.
  bool _serverOnline = false;
  bool _availabilityPending = false;
  DateTime? _availabilityExpiresAt;
  String? _lastAvailabilityError;

  /// In-flight guard for pickup/complete so a double tap cannot emit the
  /// same mutation twice. Cleared by the authoritative tripUpdate or when
  /// the server rejects with an error.
  bool _tripActionPending = false;

  /// Version of the currently tracked trip (server updated_at) for
  /// out-of-order event suppression.
  DateTime? _currentTripUpdatedAt;

  /// Last terminal trip id already surfaced to the driver (missed-outcome
  /// notice). Persisted so a restart does not repeat the same dialog.
  static const _lastTerminalNoticeKey = 'last_terminal_notice_id';
  String? _lastTerminalNoticeId;

  /// Offer notification currently posted (by offerId or tripId). Cancelled
  /// the moment the offer is accepted, declined, replaced, or settled so an
  /// actionable notification can never outlive its server-side offer.
  String? _activeOfferNotificationId;

  /// Last user-facing error the server pushed on the socket (`error`
  /// event). The trip screen surfaces this when a trip action (e.g.
  /// completing the ride) was rejected server-side — never a silent
  /// failure that leaves the driver thinking the ride finished.
  String? _socketError;
  String? get socketError => _socketError;
  void clearSocketError() {
    _socketError = null;
  }

  bool _hasPendingProfileChange = false;
  String? _pendingRequestId;
  DateTime? _pendingSince;
  Map<String, dynamic>? _pendingChangesSummary;
  bool _showApprovedToast = false;

  bool _hasDocumentActionRequired = false;
  bool _hasVehicleInspectionRequired = false;
  bool _hasDocumentSubmitted = false;
  List<Map<String, dynamic>> _documentRequirements = [];
  Set<String> _documentTypesWithActionRequired = {};

  bool _headshotActionRequired = false;

  bool _isVerified = false;
  String _verificationStatus = 'PENDING';
  String? _rejectionReason;
  bool _feedbackSeen = true;

  // Cache infrastructure
  final _cacheRepo = UserCacheRepository();
  bool _cacheHydrated = false;

  /// Tracks foreground revalidation throttle to prevent duplicate calls.
  DateTime _lastForegroundRevalidation = DateTime(2000);

  bool get hasDocumentActionRequired => _hasDocumentActionRequired;
  bool get hasVehicleInspectionRequired => _hasVehicleInspectionRequired;
  bool get hasDocumentSubmitted => _hasDocumentSubmitted;
  List<Map<String, dynamic>> get documentRequirements => _documentRequirements;
  Set<String> get documentTypesWithActionRequired => _documentTypesWithActionRequired;

  /// Returns the first document type that has action required, or null if none.
  /// Used to determine which document screen to navigate to.
  String? get documentTypeWithActionRequired {
    if (_documentTypesWithActionRequired.isEmpty) return null;
    return _documentTypesWithActionRequired.first;
  }

  bool get headshotActionRequired => _headshotActionRequired;
  void setHeadshotActionRequired(bool value) {
    _headshotActionRequired = value;
    notifyListeners();
  }
  bool get isVerified => _isVerified;
  String get verificationStatus => _verificationStatus;
  String? get rejectionReason => _rejectionReason;
  bool get feedbackSeen => _feedbackSeen;

  models.DriverStatus get status => _status;

  models.Trip? get currentTrip => _currentTrip;
  models.Trip? get incomingRequest => _incomingRequest;
  models.Trip? get lastCancelledTrip => _lastCancelledTrip;
  models.Trip? get lastCompletedTrip => _lastCompletedTrip;
  bool get cancelConfirmFailed => _cancelConfirmFailed;
  String? get lastCancelError => _lastCancelError;
  bool get isConnected => _isConnected;

  /// True when the backend holds a live availability lease for this driver.
  bool get serverOnline => _serverOnline;

  /// True between emitting `goOnline` and the server's `driverAvailability`
  /// acknowledgement. The UI should show "Going online…" rather than a
  /// definitive online state while this is true.
  bool get availabilityPending => _availabilityPending;
  DateTime? get availabilityExpiresAt => _availabilityExpiresAt;
  String? get lastAvailabilityError => _lastAvailabilityError;

  /// True while a pickup/complete mutation is awaiting confirmation.
  bool get tripActionPending => _tripActionPending;
  models.Location? get lastLocation => _lastLocation;
  double get heading => _heading;
  models.Location? get riderLocation => _riderLocation;
  List<models.ChatMessage> get messages => _messages;

  IO.Socket? get socket => _socket;

  bool get hasPendingProfileChange => _hasPendingProfileChange;
  String? get pendingRequestId => _pendingRequestId;
  DateTime? get pendingSince => _pendingSince;
  Map<String, dynamic>? get pendingChangesSummary => _pendingChangesSummary;
  bool get showApprovedToast => _showApprovedToast;

  bool get canGoOnline =>
      _isVerified &&
      !_hasPendingProfileChange &&
      !_hasDocumentActionRequired &&
      !_hasVehicleInspectionRequired &&
      !_headshotActionRequired;

  DriverComplianceStatus? buildDriverComplianceStatus() {
    if (_hasPendingProfileChange) return DriverComplianceStatus.profileChangePending;
    if (_verificationStatus == 'REJECTED') return DriverComplianceStatus.backgroundCheckRejected;
    if (_hasDocumentActionRequired) return DriverComplianceStatus.documentActionRequired;
    if (_hasVehicleInspectionRequired) return DriverComplianceStatus.vehicleInspectionRequired;
    if (_headshotActionRequired) return DriverComplianceStatus.headshotActionRequired;
    if (_verificationStatus == 'PENDING') return DriverComplianceStatus.backgroundCheckPending;
    if (_verificationStatus == 'APPROVED' && !_feedbackSeen) return DriverComplianceStatus.backgroundCheckApproved;
    if (_hasDocumentSubmitted) return DriverComplianceStatus.documentSubmitted;
    if (_showApprovedToast) return DriverComplianceStatus.profileChangeApproved;
    return null;
  }

  // ── Cache hydration on first load ────────────────────────────────

  /// Called after the socket connects and driver ID is available.
  /// Hydrates state from cached data so the UI renders immediately,
  /// then fetches authoritative data in the background.
  Future<void> hydrateFromCache(String driverId) async {
    if (_cacheHydrated) return;
    _cacheRepo.setDriverId(driverId);
    _cacheHydrated = true;

    // 1. Hydrate profile from cache (Class A — fast render)
    final cachedProfile = _cacheHydrateProfile();
    if (cachedProfile != null) {
      // Profile data already applied via _cacheHydrateProfile
      debugPrint('[CACHE] Profile hydrated from cache');
    }

    // 2. Hydrate document requirements from cache (Class B — fast render)
    final cachedDocReqs = _cacheRepo.getCachedDocumentRequirements();
    if (cachedDocReqs != null) {
      _applyDocumentRequirements(cachedDocReqs);
      debugPrint('[CACHE] Document requirements hydrated from cache');
    }

    // 3. Hydrate verification status from cache
    final cachedVerification = _cacheRepo.getCachedVerificationStatus();
    if (cachedVerification != null) {
      debugPrint('[CACHE] Verification status hydrated from cache');
    }

    // 4. Hydrate profile change pending state
    final cachedPending = _cacheRepo.getCachedHasPendingProfileChange();
    if (cachedPending != null) {
      debugPrint('[CACHE] Pending profile change state hydrated from cache');
    }

    notifyListeners();

    // 5. Background revalidation of all critical state
    _revalidateAfterHydration();
  }

  Map<String, dynamic>? _cacheHydrateProfile() {
    try {
      final cached = CacheService.instance.get(CacheKeys.driverProfile(
        _cacheRepo.driverId,
      ));
      if (cached == null) return null;
      final profile = Map<String, dynamic>.from(cached as Map);
      _applyProfileState(profile);
      return profile;
    } catch (_) {
      return null;
    }
  }

  Future<void> _revalidateAfterHydration() async {
    debugPrint('[CACHE] Starting background revalidation after hydration');
    try {
      await _fetchAndCacheProfile();
      await _fetchAndCacheDocumentRequirements();
    } catch (e) {
      debugPrint('[CACHE] Background revalidation error: $e');
    }
  }

  // ── Foreground revalidation (called from main.dart lifecycle) ────

  /// Called when the app returns to foreground.
  /// Recovery (socket re-init + authoritative trip resync) is NEVER
  /// throttled — it is the difference between a driver seeing their live
  /// trip and a blank dashboard after a quick background/foreground around
  /// a dead socket. Only the expensive profile/document revalidation is
  /// throttled.
  Future<void> onAppForegrounded() async {
    debugPrint('[CACHE] App foregrounded — resyncing ride state');

    // If the socket is disconnected (e.g. transient DNS failure),
    // re-initialize it so the built-in reconnector gets a fresh start.
    if (_socket == null || !_socket!.connected) {
      debugPrint('[CACHE] Socket disconnected on foreground — reinitializing');
      final token = SecureTokenStore.token;
      if (token != null) {
        initSocket(token);
      }
    } else {
      // Live socket: still reconcile authoritative state. Matching, offers,
      // or a terminal transition may all have happened while suspended, and
      // the socket may have silently missed events (OS suspend, doze).
      _socket?.emit('getCurrentTrip');
      _socket?.emit('getDriverAvailability');
      _socket?.emit('getPendingOffer');
    }

    // REST resync on EVERY foreground: recovery must not depend on the
    // socket (a blocked WebSocket upgrade left mid-trip drivers stuck on
    // the dashboard before this).
    await hydrateFromServer();

    // Expensive compliance revalidation only: throttled to once / 30 s.
    final now = DateTime.now();
    if (now.difference(_lastForegroundRevalidation).inSeconds < 30) {
      debugPrint('[CACHE] Foreground revalidation throttled');
      return;
    }
    _lastForegroundRevalidation = now;

    try {
      // Revalidate compliance-critical data in parallel
      await Future.wait([
        _fetchAndCacheProfile(),
        _fetchAndCacheDocumentRequirements(),
      ]);
    } catch (e) {
      debugPrint('[CACHE] Foreground revalidation error: $e');
    }
  }

  /// REST hydration of the authoritative active trip — the socket-independent
  /// recovery path, called at cold start, on foreground and on connect.
  /// Returns true when an active trip was adopted.
  Future<bool> hydrateFromServer() async {
    if (SecureTokenStore.token == null) return false;
    try {
      final response = await ApiService.dio.get('/ride/current');
      final data = response.data;
      if (data is! Map) return false;
      final rawTrip = data['trip'];
      if (rawTrip is Map) {
        final raw = Map<String, dynamic>.from(rawTrip);
        debugPrint('[RIDE] Hydrated active trip from REST: ${raw['id']} (${raw['status']})');
        applyTripUpdate(models.Trip.fromJson(raw), raw);
        return true;
      }
      // Authoritative "no active trip": settle any stale local belief so a
      // driver whose ride was resolved while offline returns to idle.
      final hadTrip =
          _currentTrip != null || _status == models.DriverStatus.onTrip;
      if (hadTrip) {
        debugPrint('[RIDE] REST reports no active trip — clearing stale local state');
        _currentTrip = null;
        _incomingRequest = null;
        _currentTripUpdatedAt = null;
        _status = _serverOnline
            ? models.DriverStatus.online
            : models.DriverStatus.offline;
        _clearOfferNotification();
        notifyListeners();
      }
      return false;
    } catch (e) {
      debugPrint('[RIDE] hydrateFromServer failed (kept local state): $e');
      return false;
    }
  }

  // ── Token / socket initialization ────────────────────────────────

  void updateToken(String token) {
    initSocket(token);
  }

  // ── Cache-aware profile fetching ─────────────────────────────────

  /// Cache-first profile fetch with background revalidation.
  Future<Map<String, dynamic>> fetchProfile() async {
    final driverId = _cacheRepo.driverId.isNotEmpty ? _cacheRepo.driverId : null;

    if (!_cacheHydrated && driverId != null) {
      _cacheRepo.setDriverId(driverId);
      _cacheHydrated = true;
    }

    // Cache-first: try L1/L2
    if (driverId != null) {
      final cached = CacheService.instance.get(CacheKeys.driverProfile(driverId));
      if (cached != null) {
        final profile = Map<String, dynamic>.from(cached as Map);
        _applyProfileState(profile);
        notifyListeners();

        // Background revalidation if stale
        final staleness = CacheService.instance.staleness(CacheKeys.driverProfile(driverId));
        if (staleness != Staleness.fresh) {
          _fetchAndCacheProfile();
        }
        return profile;
      }
    }

    // Cache miss: fetch authoritative
    return _fetchAndCacheProfile();
  }

  Future<Map<String, dynamic>> _fetchAndCacheProfile() async {
    try {
      final profile = await UserService.getProfile();
      _applyProfileState(profile);
      final driverId = _cacheRepo.driverId.isNotEmpty ? _cacheRepo.driverId : null;
      if (driverId != null) {
        await CacheService.instance.set(
          CacheKeys.driverProfile(driverId),
          profile,
          CachePolicy.profile,
        );
      }
      notifyListeners();
      return profile;
    } catch (e) {
      debugPrint('Error fetching profile: $e');
      rethrow;
    }
  }

  void _applyProfileState(Map<String, dynamic> profile) {
    _hasPendingProfileChange = profile['has_pending_profile_change'] == true;
    _pendingRequestId = profile['pending_request_id']?.toString();
    final since = profile['pending_requested_at']?.toString();
    _pendingSince = since == null ? null : DateTime.tryParse(since);
    final raw = profile['pending_changes_summary'];
    _pendingChangesSummary = raw is Map
        ? Map<String, dynamic>.from(raw)
        : null;
    if (!_hasPendingProfileChange) {
      _pendingRequestId = null;
      _pendingSince = null;
      _pendingChangesSummary = null;
    }

    _verificationStatus = (profile['background_check_status'] ?? 'PENDING').toString();
    _rejectionReason = profile['rejection_reason']?.toString();
    _feedbackSeen = profile['verification_feedback_seen'] == true;
    _isVerified = profile['is_active'] == true || profile['is_active'] == 'true';

    // Cache verification status separately (Class B)
    final driverId = _cacheRepo.driverId.isNotEmpty ? _cacheRepo.driverId : null;
    if (driverId != null) {
      CacheService.instance.set(
        CacheKeys.driverVerificationStatus(driverId),
        _verificationStatus,
        CachePolicy.verificationStatus,
      );
    }
  }

  // ── Cache-aware document requirements fetching ───────────────────

  Future<void> fetchDocumentRequirements() async {
    final driverId = _cacheRepo.driverId.isNotEmpty ? _cacheRepo.driverId : null;

    // Cache-first
    if (driverId != null) {
      final cached = CacheService.instance.get(CacheKeys.driverDocumentRequirements(driverId));
      if (cached != null) {
        final reqs = (cached as List)
            .map((r) => Map<String, dynamic>.from(r as Map))
            .toList();
        _applyDocumentRequirements(reqs);
        notifyListeners();

        final staleness = CacheService.instance.staleness(CacheKeys.driverDocumentRequirements(driverId));
        if (staleness != Staleness.fresh) {
          _fetchAndCacheDocumentRequirements();
        }
        return;
      }
    }

    await _fetchAndCacheDocumentRequirements();
  }

  Future<void> _fetchAndCacheDocumentRequirements() async {
    try {
      final docReqs = await UserService.getDocumentRequirements();
      final reqs = (docReqs['requirements'] as List?)
              ?.map((r) => Map<String, dynamic>.from(r as Map))
              .toList() ??
          [];
      _applyDocumentRequirements(reqs);
      final driverId = _cacheRepo.driverId.isNotEmpty ? _cacheRepo.driverId : null;
      if (driverId != null) {
        await CacheService.instance.set(
          CacheKeys.driverDocumentRequirements(driverId),
          reqs,
          CachePolicy.documentRequirements,
        );
      }
      notifyListeners();
    } catch (e) {
      debugPrint('Error fetching document requirements: $e');
    }
  }

  void _applyDocumentRequirements(List<Map<String, dynamic>> reqs) {
    _documentRequirements = reqs;
    _hasVehicleInspectionRequired = reqs.any((r) =>
        r['status'] == 'resubmission_required' &&
        r['document_type'] == 'inspection_photo_url');
    _hasDocumentActionRequired = reqs.any((r) =>
        r['status'] == 'resubmission_required' &&
        r['document_type'] != 'inspection_photo_url');
    _hasDocumentSubmitted = reqs.any((r) =>
        r['status'] == 'submitted');

    // Track specific document types with action required
    _documentTypesWithActionRequired = reqs
        .where((r) => r['status'] == 'resubmission_required')
        .map((r) => r['document_type'] as String)
        .toSet();
  }

  // ── Socket initialization with cache-awareness ───────────────────

  void initSocket(String token) {
    if (_socket != null) {
      _socket!.off('');
      _socket!.disconnect();
      _socket!.dispose();
      _socket = null;
    }
    // Socket base URL is derived once in ApiService so HTTP and WebSocket
    // gateways can never drift. Fall back to the production URL on missing
    // env (mirrors ApiService.baseUrl behavior).
    final url = ApiService.socketBaseUrl;
    debugPrint('--- DRIVER SOCKET INIT --- URL=$url');

    _socket = IO.io(url, <String, dynamic>{
      // Negotiate WebSocket first, then fall back to polling. This mirrors
      // socket.io-client defaults and gives HTTP-only paths a chance when a
      // reverse proxy blocks ws upgrades (which is the most common cause of
      // the previously-seen "Failed host lookup" symptom on Android emulators).
      'transports': ['websocket', 'polling'],
      'forceNew': true,
      'reconnection': true,
      'reconnectionAttempts': double.infinity,
      'reconnectionDelay': 1000,
      'reconnectionDelayMax': 15000,
      'randomizationFactor': 0.5,
      'auth': {'token': token, 'role': 'DRIVER'},
    });

    _socket!.onConnect((_) {
      debugPrint('[SOCKET] Driver connected URL=' + url + ' transport=' + (_socket?.io.engine?.transport?.name ?? '?'));
      _isConnected = true;
      // Extract driver ID from token and hydrate cache
      _tryHydrateFromToken(token);
      // Reconnect resync: always ask for the authoritative active trip.
      // Covers both a socket blip mid-trip AND app restart mid-trip
      // (the ACCEPTED tripUpdate is not replayed automatically, so
      // without this the driver would never recover the trip screen).
      _socket?.emit('getCurrentTrip');
      // Reconcile availability with the server instead of trusting local
      // state: the server answers with the lease it actually holds.
      _socket?.emit('getDriverAvailability');
      // If a live offer still exists server-side (we were backgrounded when
      // it was sent), the server re-emits it so returning through the app
      // icon is not a dead end.
      _socket?.emit('getPendingOffer');
      // Socket-independent recovery: adopt an authoritative active trip
      // over REST even if this socket just connected but the historical
      // events were long lost.
      hydrateFromServer();
      notifyListeners();
    });

    _socket!.on('driverAvailability', (data) {
      final map = data is Map ? Map<String, dynamic>.from(data) : <String, dynamic>{};
      final online = map['online'] == true;
      _availabilityPending = false;
      _serverOnline = online;
      final exp = map['expiresAt'];
      _availabilityExpiresAt = exp is num
          ? DateTime.fromMillisecondsSinceEpoch(exp.toInt())
          : null;
      if (online) {
        _lastAvailabilityError = null;
        // Server truth: it holds an availability lease. Adopt online unless
        // we are actively on a trip.
        if (_status == models.DriverStatus.offline) {
          _status = models.DriverStatus.online;
        }
      } else if (_status != models.DriverStatus.onTrip) {
        // Server truth: no lease (expired / rejected / went offline).
        _status = models.DriverStatus.offline;
      }
      notifyListeners();
    });

    _socket!.on('currentTripNone', (data) async {
      // Authoritative answer to getCurrentTrip: no active trip.
      final hadTrip = _currentTrip != null || _status == models.DriverStatus.onTrip;
      if (hadTrip) {
        debugPrint('[RIDE] Server reports no current trip — clearing stale local state');
        _currentTrip = null;
        _incomingRequest = null;
        _currentTripUpdatedAt = null;
        if (_status == models.DriverStatus.onTrip) {
          _status = _serverOnline
              ? models.DriverStatus.online
              : models.DriverStatus.offline;
        }
        _clearOfferNotification();
        notifyListeners();
      }
      // Terminal-outcome notice: the server includes the driver's most
      // recent completed/cancelled ride (last 10 min). If we were dead when
      // it happened, surface it once instead of silently resetting to idle.
      try {
        final map = data is Map ? Map<String, dynamic>.from(data) : null;
        final last = map?['lastTerminalTrip'];
        if (last is Map && _currentTrip == null) {
          await _maybeSurfaceMissedTerminal(
            models.Trip.fromJson(Map<String, dynamic>.from(last)),
          );
        }
      } catch (e) {
        debugPrint('[RIDE] lastTerminalTrip handling failed: $e');
      }
    });

    _socket!.onDisconnect((reason) {
      debugPrint('[SOCKET] Driver disconnected URL=' + url + ' reason=' + reason.toString());
      _isConnected = false;
      notifyListeners();
    });

    _socket!.onConnectError((err) {
      // Log the actual URL and the raw error to surface the real reason
      // (DNS, ws upgrade blocked by proxy, wrong path, ...) instead of the
      // misleading hardcoded "DNS resolution failed for netride.onrender.com"
      // message it replaced.
      debugPrint('[SOCKET] Driver connect error URL=$url raw=$err');
      _isConnected = false;
      notifyListeners();
    });

    _socket!.on('newTripRequest', (data) {
      final trip = models.Trip.fromJson(data);
      _incomingRequest = trip;
      // Do NOT clear `_settledTripIds`: a delayed terminal event for the
      // previous ride can arrive after the next offer and would otherwise
      // resurrect it. The set is bounded in _ackTerminalNotice.
      _lastCompletedTrip = null;
      _maybeNotifyIncomingOffer(trip, data);
      notifyListeners();
    });

    _socket!.on('tripUpdate', (data) {
      if (data is! Map) return;
      applyTripUpdate(
        models.Trip.fromJson(Map<String, dynamic>.from(data)),
        Map<String, dynamic>.from(data),
      );
    });

    _socket!.on('cancelTripFailed', (data) {
      debugPrint('[RIDE] Server rejected cancellation: $data');
      String message = 'Unable to cancel the ride. Please try again.';
      try {
        final map = Map<String, dynamic>.from(data as Map);
        message = map['message']?.toString() ?? message;
      } catch (_) {}
      _cancelling = false;
      _cancelConfirmTimer?.cancel();
      _cancelConfirmTimer = null;
      _cancelConfirmFailed = true;
      _lastCancelError = message;
      notifyListeners();
    });

    _socket!.on('messageReceived', (data) {
      final msg = models.ChatMessage.fromJson(data);
      _messages.add(msg);
      notifyListeners();
    });

    _socket!.on('riderLocationUpdate', (data) {
      _riderLocation = models.Location.fromJson(data);
      notifyListeners();
    });

    _socket!.on('navigationStarted', (data) {
      try {
        final tripId = (data as Map)['tripId']?.toString();
        final leg = (data['leg'] as String?) ?? 'pickup';
        final route = data['route'];
        if (tripId == null || route is! Map) return;
        debugPrint('[NAV] navigationStarted leg=$leg tripId=$tripId');
      } catch (e) {
        debugPrint('Bad navigationStarted payload: $e');
      }
    });

    _socket!.on('navigationLegAdvanced', (data) {
      try {
        final tripId = (data as Map)['tripId']?.toString();
        debugPrint('[NAV] leg advanced -> destination for $tripId');
        notifyListeners();
      } catch (e) {
        debugPrint('Bad navigationLegAdvanced payload: $e');
      }
    });

    _socket!.on('navigationRouteUpdated', (data) {
      try {
        final tripId = (data as Map)['tripId']?.toString();
        debugPrint('[NAV] route updated for $tripId');
      } catch (e) {
        debugPrint('Bad navigationRouteUpdated payload: $e');
      }
    });

    _socket!.on('navigationRerouteRequested', (data) {
      try {
        final tripId = (data as Map)['tripId']?.toString();
        debugPrint('[NAV] reroute requested for $tripId');
      } catch (e) {
        debugPrint('Bad navigationRerouteRequested payload: $e');
      }
    });

    _socket!.on('navigationEnded', (data) {
      try {
        final tripId = (data as Map)['tripId']?.toString();
        debugPrint('[NAV] navigation ended for $tripId');
      } catch (e) {
        debugPrint('Bad navigationEnded payload: $e');
      }
    });

    // ── Cache-aware Socket.IO event handlers ──────────────────────
    // These events signal remote admin changes. We invalidate the
    // affected cache keys and re-fetch authoritative data.

    _socket!.on('documentRequirementsChanged', (data) async {
      debugPrint('[SOCKET] documentRequirementsChanged received — invalidating cache');
      final driverId = _cacheRepo.driverId.isNotEmpty ? _cacheRepo.driverId : null;
      if (driverId != null) {
        await CacheService.instance.invalidate(CacheKeys.driverDocumentRequirements(driverId));
        await CacheService.instance.invalidate(CacheKeys.driverProfile(driverId));
        await CacheService.instance.invalidate(CacheKeys.driverVerificationStatus(driverId));
      }
      // Re-fetch authoritative state
      await _fetchAndCacheDocumentRequirements();
      try {
        await _fetchAndCacheProfile();
      } catch (_) {}
    });

    _socket!.on('vehicleRequirementsChanged', (data) async {
      debugPrint('[SOCKET] vehicleRequirementsChanged received — invalidating cache');
      final driverId = _cacheRepo.driverId.isNotEmpty ? _cacheRepo.driverId : null;
      if (driverId != null) {
        await CacheService.instance.invalidate(CacheKeys.driverVehicle(driverId));
        await CacheService.instance.invalidate(CacheKeys.driverProfile(driverId));
      }
      try {
        await _fetchAndCacheProfile();
      } catch (_) {}
    });

    _socket!.on('profileChangeReviewed', (data) async {
      debugPrint('[SOCKET] profileChangeReviewed received — invalidating cache');
      final driverId = _cacheRepo.driverId.isNotEmpty ? _cacheRepo.driverId : null;
      if (driverId != null) {
        await CacheService.instance.invalidateAll([
          CacheKeys.driverProfile(driverId),
          CacheKeys.driverProfileChange(driverId),
          CacheKeys.driverVerificationStatus(driverId),
          CacheKeys.driverEligibility(driverId),
        ]);
      }
      try {
        final map = Map<String, dynamic>.from(data as Map);
        final decision = map['decision']?.toString();
        await _fetchAndCacheProfile();
        if (decision == 'APPROVED') {
          _showApprovedToast = true;
          notifyListeners();
        } else if (decision == 'REJECTED') {
          notifyListeners();
        }
      } catch (e) {
        debugPrint('Bad profileChangeReviewed payload: $e');
      }
    });

    _socket!.on('tipReceived', (data) {
      try {
        final map = Map<String, dynamic>.from(data as Map);
        final amount = map['amount']?.toString() ?? '0.00';
        final tipperName = map['tipperName']?.toString() ?? 'Your rider';

        SoundService.instance.play(SoundEffect.tipReceived);

        final context = ApiService.navigatorKey.currentContext;
        if (context != null) {
          showDialog(
            context: context,
            builder: (context) => TipReceivedDialog(
              amount: amount,
              tipperName: tipperName,
            ),
          );
        }
      } catch (e) {
        debugPrint('Error processing tipReceived event: $e');
      }
    });

    _socket!.on('error', (data) {
      debugPrint('[RIDE] Socket error: $data');
      final msg = data is String
          ? data
          : (data is Map && data['message'] is String)
              ? data['message'] as String
              : null;
      if (msg != null && msg.isNotEmpty) {
        _socketError = msg;
        // A rejected pickup/complete must release the in-flight guard so the
        // driver can correct the situation and retry.
        _tripActionPending = false;
        notifyListeners();
      }
    });

    // The server rejected our acceptTrip (offer expired / superseded /
    // ride cancelled). Roll back the optimistic _currentTrip so the
    // driver does not sit on a phantom trip screen. The trip screen
    // reacts to currentTrip == null by returning to the dashboard.
    _socket!.on('acceptTripFailed', (data) {
      debugPrint('[RIDE] Server rejected accept: $data');
      final map = data is Map ? Map<String, dynamic>.from(data) : <String, dynamic>{};
      final failedTripId = map['tripId']?.toString();
      final message = map['message']?.toString();
      if (message != null && message.isNotEmpty) _socketError = message;
      // Only roll back the offer we actually tried to accept — a stale
      // failure for an older offer must not clear a newer optimistic trip.
      if (_currentTrip != null &&
          _currentTrip!.status == models.TripStatus.REQUESTED &&
          (failedTripId == null || failedTripId == _currentTrip!.id)) {
        _currentTrip = null;
        _status = _serverOnline
            ? models.DriverStatus.online
            : models.DriverStatus.offline;
      }
      notifyListeners();
    });

    // Restore the last terminal-notice id so a missed-ride dialog is shown
    // at most once per ride across process restarts.
    SharedPreferences.getInstance().then((prefs) {
      _lastTerminalNoticeId = prefs.getString(_lastTerminalNoticeKey);
    }).catchError((_) {});
  }

  // ── Missed terminal outcomes (killed while assigned) ─────────────

  /// Surface a completed/cancelled ride that happened while this app was
  /// not running. Idempotent per trip id (persisted), so reconnect storms
  /// and restarts never repeat the same dialog.
  Future<void> _maybeSurfaceMissedTerminal(models.Trip trip) async {
    if (_lastTerminalNoticeId == trip.id) return;
    if (_settledTripIds.contains(trip.id)) return;
    _lastTerminalNoticeId = trip.id;
    _settledTripIds.add(trip.id);
    if (trip.status == models.TripStatus.CANCELLED) {
      _lastCancelledTrip = trip;
    } else if (trip.status == models.TripStatus.COMPLETED) {
      _lastCompletedTrip = trip;
    } else {
      return;
    }
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_lastTerminalNoticeKey, trip.id);
    } catch (_) {}
    notifyListeners();
  }

  void _ackTerminalNotice(String tripId) {
    _lastTerminalNoticeId = tripId;
    SharedPreferences.getInstance()
        .then((prefs) => prefs.setString(_lastTerminalNoticeKey, tripId))
        .catchError((_) => false);
    // Bounded memory: insertion-ordered set, drop the oldest beyond 50.
    while (_settledTripIds.length > 50) {
      _settledTripIds.remove(_settledTripIds.first);
    }
  }

  // ── Offer notifications (actionable, background-safe) ────────────

  /// Mirrors a socket-delivered offer into a local notification when the
  /// app is not visible. The notification carries only the server offer
  /// identity — accept/decline actions call the authenticated REST API,
  /// which re-validates ownership, status, and expiry.
  void _maybeNotifyIncomingOffer(models.Trip trip, dynamic raw) {
    final newId = trip.offerId ?? trip.id;
    if (_activeOfferNotificationId != null &&
        _activeOfferNotificationId != newId) {
      NotificationService.instance
          .cancelOfferNotification(_activeOfferNotificationId!);
    }
    _activeOfferNotificationId = newId;

    if (WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed) {
      // The in-app offer card is visible; the socket path wins.
      return;
    }
    final map =
        raw is Map ? Map<String, dynamic>.from(raw) : <String, dynamic>{};
    final earnings = map['driver_earnings_cents'] ?? trip.driverEarningsCents;
    NotificationService.instance.showRideOfferNotification({
      'tripId': trip.id,
      if (trip.offerId != null) 'offerId': trip.offerId,
      if (trip.expiresAt != null)
        'expiresAt': trip.expiresAt!.toUtc().toIso8601String(),
      if (earnings != null) 'earningsCents': earnings,
      if (trip.pickup.address != null) 'pickupAddress': trip.pickup.address,
    });
  }

  /// Removes a still-visible offer notification (accepted, declined,
  /// replaced, or settled server-side). A no-op when nothing is posted.
  void _clearOfferNotification() {
    final id = _activeOfferNotificationId;
    if (id == null) return;
    _activeOfferNotificationId = null;
    NotificationService.instance.cancelOfferNotification(id);
  }

  /// Applies one authoritative trip payload under every ordering guard.
  /// Exposed for the socket listener AND for tests, so the stale/duplicate
  /// rules are asserted on the real code path:
  ///   1. settled ids never resurrect,
  ///   2. an event for a different trip never replaces the active one,
  ///   3. an older `updated_at` never overwrites a newer state.
  @visibleForTesting
  void applyTripUpdate(models.Trip trip, [Map<String, dynamic>? raw]) {
    // Stale guard (spec §40/§61): never resurrect a ride that already
    // reached a terminal state, and never switch to a different ride
    // than the one currently active. Without this, a delayed ACCEPTED
    // resets _currentTrip → the availability screen re-pushes /trip →
    // the driver is thrown back to the route screen mid-chat / mid-cancel.
    if (_settledTripIds.contains(trip.id)) {
      debugPrint('[RIDE] Ignoring stale tripUpdate for settled trip ${trip.id}');
      return;
    }

    final isActiveStatus = trip.status == models.TripStatus.ACCEPTED ||
        trip.status == models.TripStatus.DRIVER_ARRIVING ||
        trip.status == models.TripStatus.IN_PROGRESS;

    if (_currentTrip != null && _currentTrip!.id != trip.id) {
      debugPrint('[RIDE] Ignoring ${trip.status} tripUpdate for different trip ${trip.id} (current ${_currentTrip!.id})');
      return;
    }

    final incomingVersion = trip.updatedAt;
    if (incomingVersion != null &&
        _currentTrip != null &&
        _currentTrip!.id == trip.id &&
        _currentTripUpdatedAt != null &&
        incomingVersion.isBefore(_currentTripUpdatedAt!)) {
      debugPrint('[RIDE] Ignoring out-of-order tripUpdate (v=$incomingVersion < $_currentTripUpdatedAt)');
      return;
    }

    if (isActiveStatus) {
      _currentTrip = trip;
      _currentTripUpdatedAt = incomingVersion;
      _incomingRequest = null;
      _tripActionPending = false;
      _status = models.DriverStatus.onTrip;
      _clearOfferNotification();
      notifyListeners();
    } else if (trip.status == models.TripStatus.COMPLETED) {
      if (_incomingRequest?.id == trip.id) {
        _incomingRequest = null;
      }
      // Capture the authoritative completion payload (carries
      // driver_earnings_cents) BEFORE clearing the active trip — the
      // completion dialog reads it right after this update arrives.
      _lastCompletedTrip = trip;
      _settledTripIds.add(trip.id);
      _ackTerminalNotice(trip.id);
      _currentTrip = null;
      _currentTripUpdatedAt = null;
      _tripActionPending = false;
      _status = _serverOnline
          ? models.DriverStatus.online
          : models.DriverStatus.offline;
      _clearOfferNotification();
      notifyListeners();
    } else if (trip.status == models.TripStatus.CANCELLED) {
      // First-class cancelled state (never a raw "ride == null" exit):
      // keep the terminal trip so the UI can render who cancelled + why,
      // then the UI acknowledges it (ackCancelled) before returning home.
      if (_incomingRequest?.id == trip.id) {
        _incomingRequest = null;
      }
      _settledTripIds.add(trip.id);
      _ackTerminalNotice(trip.id);
      _currentTrip = null;
      _currentTripUpdatedAt = null;
      _tripActionPending = false;
      _messages = [];
      _riderLocation = null;
      _lastCancelledTrip = trip;
      _cancelConfirmFailed = false;
      _onCancelConfirmed();
      _status = _serverOnline
          ? models.DriverStatus.online
          : models.DriverStatus.offline;
      _clearOfferNotification();
      notifyListeners();
    }
  }

  void _tryHydrateFromToken(String token) {
    try {
      final parts = token.split('.');
      if (parts.length != 3) return;
      String payload = parts[1];
      // Restore base64 padding if missing
      switch (payload.length % 4) {
        case 2:
          payload += '==';
          break;
        case 3:
          payload += '=';
          break;
      }
      // JWT payloads use base64url; `base64Decode` throws on '-'/'_' and
      // non-ASCII payloads used to abort hydration entirely.
      final normalized = base64Url.normalize(payload);
      final decoded = utf8.decode(base64Url.decode(normalized));
      final json = jsonDecode(decoded) as Map<String, dynamic>;
      final driverId = json['id']?.toString();
      if (driverId != null && driverId.isNotEmpty) {
        _cacheRepo.setDriverId(driverId);
        hydrateFromCache(driverId);
      }
    } catch (e) {
      debugPrint('[CACHE] Token hydration failed: $e');
    }
  }

  /// Pulls the latest profile from the server, bypasses cache.
  Future<Map<String, dynamic>> refreshProfile() async {
    // Invalidate profile cache
    final driverId = _cacheRepo.driverId.isNotEmpty ? _cacheRepo.driverId : null;
    if (driverId != null) {
      await CacheService.instance.invalidate(CacheKeys.driverProfile(driverId));
    }
    return _fetchAndCacheProfile();
  }

  /// Pulls the latest document requirements from the server, bypasses cache.
  /// Call after a document/vehicle resubmission so compliance cards (e.g. the
  /// "vehicle inspection required" card) never render stale state.
  Future<void> refreshDocumentRequirements() async {
    final driverId = _cacheRepo.driverId.isNotEmpty ? _cacheRepo.driverId : null;
    if (driverId != null) {
      await CacheService.instance.invalidate(CacheKeys.driverDocumentRequirements(driverId));
    }
    await _fetchAndCacheDocumentRequirements();
  }

  /// Refreshes profile + document requirements from the server, bypassing
  /// cache. Call after any mutation (uploads, resubmissions, profile
  /// changes) and from pull-to-refresh so all compliance cards are fresh.
  Future<void> refreshAll() async {
    final driverId = _cacheRepo.driverId.isNotEmpty ? _cacheRepo.driverId : null;
    if (driverId != null) {
      await CacheService.instance.invalidate(CacheKeys.driverProfile(driverId));
      await CacheService.instance.invalidate(CacheKeys.driverDocumentRequirements(driverId));
      await CacheService.instance.invalidate(CacheKeys.driverVerificationStatus(driverId));
    }
    await Future.wait([
      _fetchAndCacheProfile(),
      _fetchAndCacheDocumentRequirements(),
    ]);
  }

  void markProfileChangeApprovedShown() {
    _showApprovedToast = false;
    notifyListeners();
  }

  // ── Message / online / offline / trip actions ────────────────────

  void sendMessage(String tripId, String message) {
    _socket?.emit('sendMessage', {'tripId': tripId, 'message': message});
    _messages.add(models.ChatMessage(
      senderId: 'me',
      role: 'driver',
      message: message,
      timestamp: DateTime.now(),
    ));
    notifyListeners();
  }

  void clearMessages() {
    _messages = [];
    notifyListeners();
  }

  /// Request the online transition. Returns false when the socket is not
  /// connected (the caller must NOT claim the driver is online). On success
  /// the local state moves to a pending transition; the authoritative
  /// `driverAvailability` ack from the server settles it.
  Future<bool> setOnline({double? lat, double? lng}) async {
    if (!_isConnected || _socket == null) {
      _lastAvailabilityError =
          'You are offline. Wait for the connection to return, then try again.';
      notifyListeners();
      return false;
    }
    _lastAvailabilityError = null;
    _status = models.DriverStatus.online;
    _availabilityPending = true;
    final useLat = lat ?? _lastLocation?.lat;
    final useLng = lng ?? _lastLocation?.lng;
    if (useLat != null && useLng != null) {
      _socket?.emit('goOnline', {'lat': useLat, 'lng': useLng});
    } else {
      // No fix yet: the server still creates the availability lease, but
      // the driver is not dispatchable until the first location arrives.
      _socket?.emit('goOnline');
    }
    notifyListeners();
    return true;
  }

  /// Go offline. A driver mid-trip is NOT released locally: the server
  /// keeps the accepted trip's position until it finishes, and this client
  /// keeps rendering the trip.
  void setOffline() {
    _availabilityPending = false;
    _serverOnline = false;
    if (_status != models.DriverStatus.onTrip) {
      _status = models.DriverStatus.offline;
      _incomingRequest = null;
      _clearOfferNotification();
    }
    _socket?.emit('goOffline');
    notifyListeners();
  }

  void acceptTrip(String tripId) {
    // Optimistically set _currentTrip from the incoming request so the
    // trip screen doesn't race with the async tripUpdate socket event.
    // Only do this while the socket is actually connected: an accept
    // emitted into a dead socket is silently dropped, and the optimistic
    // state must not push the driver onto a phantom trip.
    if (!_isConnected) {
      debugPrint('[RIDE] ⚠️ acceptTrip skipped — socket not connected');
      _socketError = 'Connection lost. Reconnecting — try accepting again.';
      notifyListeners();
      return;
    }
    // Double-tap / retransmit guard: one accept mutation per offer.
    if (_tripActionPending) return;
    if (_currentTrip?.id == tripId &&
        _currentTrip!.status != models.TripStatus.REQUESTED) {
      return; // already accepted
    }
    _tripActionPending = true;
    if (_incomingRequest != null && _incomingRequest!.id == tripId) {
      _currentTrip = _incomingRequest;
      _incomingRequest = null;
      _lastCompletedTrip = null;
      _status = models.DriverStatus.onTrip;
      _clearOfferNotification();
      notifyListeners();
    }
    final offerId = _currentTrip?.offerId;
    _socket?.emit('acceptTrip',
        offerId != null ? {'tripId': tripId, 'offerId': offerId} : tripId);
  }

  /// Guards against double-tap / concurrent cancel emits (spec §27/§61).
  bool _cancelling = false;
  Timer? _cancelConfirmTimer;

  /// Request cancellation to the backend. The local transition to the
  /// cancelled state happens ONLY on the authoritative `tripUpdate`
  /// (CANCELLED) event — or via a bounded offline fallback that marks the
  /// confirmation as failed so the UI can distinguish "confirmed" from
  /// "request failed / connection lost" (spec §60).
  void cancelTrip(String tripId, {String? reasonCode, String? reasonText}) {
    if (_cancelling) return;
    _cancelling = true;
    _cancelConfirmFailed = false;
    _lastCancelError = null;
    notifyListeners();

    _socket?.emit('cancelTrip', {
      'tripId': tripId,
      if (reasonCode != null) 'reasonCode': reasonCode,
      if (reasonText != null) 'reasonText': reasonText,
    });

    // Offline fallback ladder: if no authoritative CANCELLED tripUpdate
    // arrives (socket dead / server unreachable), the REST endpoint is
    // retried with identical ownership/state rules. Only when BOTH paths
    // fail does the UI show "could not confirm" — the trip is KEPT, never
    // faked away locally (a local-only cancel could diverge from a server
    // ride that is still assigned).
    _cancelConfirmTimer?.cancel();
    _cancelConfirmTimer = Timer(const Duration(seconds: 12), () {
      _confirmCancelViaRest(tripId);
    });
  }

  /// REST fallback for the driver cancellation (see [cancelTrip]). Applies
  /// the authoritative cancelled trip on success; keeps the trip active and
  /// flags the failure on error so the driver can retry.
  Future<void> _confirmCancelViaRest(String tripId) async {
    if (!_cancelling) return;
    debugPrint('[RIDE] Cancel confirmation not received — retrying over REST');
    try {
      final response = await ApiService.dio.post(
        '/ride/driver-cancel',
        data: {'tripId': tripId},
      );
      final data = response.data;
      final trip = data is Map ? data['trip'] : null;
      _cancelling = false;
      _cancelConfirmFailed = false;
      _lastCancelError = null;
      _cancelConfirmTimer?.cancel();
      _cancelConfirmTimer = null;
      if (trip is Map) {
        final raw = Map<String, dynamic>.from(trip);
        applyTripUpdate(models.Trip.fromJson(raw), raw);
      } else {
        notifyListeners();
      }
    } catch (e) {
      if (!_cancelling) return;
      debugPrint('[RIDE] Cancel REST fallback failed: $e');
      _cancelling = false;
      _cancelConfirmFailed = true;
      _lastCancelError =
          'We couldn\'t confirm the cancellation. Check your connection and try again.';
      _cancelConfirmTimer?.cancel();
      _cancelConfirmTimer = null;
      notifyListeners();
    }
  }

  /// Server-confirmed cancellation (from tripUpdate CANCELLED). Clears
  /// the fallback timer; the cancelled trip itself is stored as the
  /// first-class cancelled state by the tripUpdate handler.
  void _onCancelConfirmed() {
    _cancelling = false;
    _cancelConfirmFailed = false;
    _cancelConfirmTimer?.cancel();
    _cancelConfirmTimer = null;
  }

  /// The UI has shown the cancelled state; clear it so the driver returns
  /// to the normal online/home screen.
  void ackCancelled() {
    if (_lastCancelledTrip != null) _ackTerminalNotice(_lastCancelledTrip!.id);
    if (_lastCompletedTrip != null) _ackTerminalNotice(_lastCompletedTrip!.id);
    _lastCancelledTrip = null;
    _lastCompletedTrip = null;
    _cancelConfirmFailed = false;
    _lastCancelError = null;
    _cancelling = false;
    _cancelConfirmTimer?.cancel();
    _cancelConfirmTimer = null;
    // NOTE: `_settledTripIds` deliberately survives the ack — delayed
    // duplicate terminal events after returning home must not resurrect
    // the ride. Memory is bounded in _ackTerminalNotice.
    notifyListeners();
  }

  void declineTrip(String tripId) {
    final offerId =
        _incomingRequest?.id == tripId ? _incomingRequest?.offerId : null;
    _socket?.emit('declineTrip',
        offerId != null ? {'tripId': tripId, 'offerId': offerId} : tripId);
    if (_incomingRequest?.id == tripId) {
      _incomingRequest = null;
      _clearOfferNotification();
      notifyListeners();
    }
  }

  /// Start the trip. Guarded: the UI disables the CTA while pending, and
  /// this guard stops a programmatic/double tap from emitting twice. The
  /// authoritative IN_PROGRESS tripUpdate (or a socket error) clears it.
  void pickUpRider(String tripId) {
    if (_tripActionPending) return;
    if (!_isConnected) {
      _socketError = 'Connection lost. Reconnecting — try again.';
      notifyListeners();
      return;
    }
    _tripActionPending = true;
    _socketError = null;
    _socket?.emit('pickUpRider', tripId);
    // Safety release: if no confirmation/error arrives the button must not
    // stay disabled forever.
    Timer(const Duration(seconds: 10), () {
      if (_tripActionPending && _currentTrip?.status != models.TripStatus.IN_PROGRESS) {
        _tripActionPending = false;
        notifyListeners();
      }
    });
    notifyListeners();
  }

  void completeTrip(String tripId) {
    if (_tripActionPending) return;
    _tripActionPending = true;
    _socket?.emit('completeTrip', tripId);
    notifyListeners();
  }

  /// Releases the in-flight pickup/complete guard when the UI abandons the
  /// attempt (e.g. screen popped).
  void clearTripActionPending() {
    if (!_tripActionPending) return;
    _tripActionPending = false;
    notifyListeners();
  }

  /// Emits `completeTrip` and resolves only when the server confirms:
  /// - true  → the authoritative COMPLETED tripUpdate arrived and cleared
  ///   `currentTrip` (the ride is really finished server-side).
  /// - false → the server rejected the completion (socket `error` captured
  ///   in [socketError]) or no confirmation arrived within [timeout].
  ///
  /// The UI must NEVER celebrate a completion that wasn't confirmed — the
  /// old flow showed "congratulations, you earned X" after a blind timeout
  /// even when the server had rejected the ride, leaving both apps stuck
  /// on the ride screen.
  Future<bool> completeTripConfirmed(
    String tripId, {
    Duration timeout = const Duration(seconds: 8),
  }) async {
    // Re-entrancy guard: only one completion attempt may be in flight; a
    // second call returns false so the UI does not run two confirmation
    // loops/dialogs from a double tap.
    if (_tripActionPending) return false;
    _tripActionPending = true;
    _socketError = null;
    notifyListeners();
    _socket?.emit('completeTrip', tripId);
    final deadline = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(deadline)) {
      await Future.delayed(const Duration(milliseconds: 150));
      if (_currentTrip == null) {
        _tripActionPending = false;
        return true;
      }
      if (_socketError != null) {
        _tripActionPending = false;
        return false;
      }
    }
    _tripActionPending = false;
    return _currentTrip == null;
  }

  Future<void> rateRide(String rideId, int rating, String reviewText) async {
    await ApiService.rateRide(
      rideId: rideId,
      rating: rating,
      reviewText: reviewText,
    );
  }

  void updateLocation(
    double lat,
    double lng, {
    double heading = 0,
    double? accuracy,
    double? speed,
    bool mock = false,
  }) {
    _lastLocation = models.Location(lat: lat, lng: lng);
    _heading = heading;
    // Accuracy/speed/mock ride along so the server can store a timestamped,
    // quality-annotated observation instead of a bare coordinate. The
    // server persists server-receipt time and refuses mock fixes at gates.
    _socket?.emit('updateLocation', {
      'lat': lat,
      'lng': lng,
      'heading': heading,
      if (accuracy != null && accuracy.isFinite) 'accuracy': accuracy,
      if (speed != null && speed.isFinite) 'speed': speed,
      if (mock) 'mock': true,
      'source': 'gps',
    });
    notifyListeners();
  }

  void setIncomingRequest(models.Trip? request) {
    _incomingRequest = request;
    notifyListeners();
  }

  // ── Logout / cleanup ─────────────────────────────────────────────

  /// Called on logout to clear all cached data for this user.
  Future<void> clearUserCache() async {
    await CacheService.instance.clearAll();
    _cacheHydrated = false;
    debugPrint('[CACHE] All user cache cleared on logout');
  }

  @override
  void dispose() {
    _cancelConfirmTimer?.cancel();
    _cancelConfirmTimer = null;
    if (_socket != null) {
      _socket!.off('');
      _socket!.disconnect();
      _socket!.dispose();
      _socket = null;
    }
    super.dispose();
  }
}