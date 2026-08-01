import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import '../models/trip_models.dart' as models;
import '../services/api_service.dart';
import '../services/user_service.dart';
import '../services/sound_service.dart';
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
  bool get isConnected => _isConnected;
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
  /// Revalidates critical Class B data but respects throttle.
  Future<void> onAppForegrounded() async {
    // Throttle: don't revalidate more than once every 30 seconds
    final now = DateTime.now();
    if (now.difference(_lastForegroundRevalidation).inSeconds < 30) {
      debugPrint('[CACHE] Foreground revalidation throttled');
      return;
    }
    _lastForegroundRevalidation = now;
    debugPrint('[CACHE] App foregrounded — revalidating critical state');

    // If the socket is disconnected (e.g. transient DNS failure),
    // re-initialize it so the built-in reconnector gets a fresh start.
    if (_socket == null || !_socket!.connected) {
      debugPrint('[CACHE] Socket disconnected on foreground — reinitializing');
      final prefs = await SharedPreferences.getInstance();
      final token = prefs.getString('jwt_token');
      if (token != null) {
        initSocket(token);
      }
    }

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
      notifyListeners();
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
      _incomingRequest = models.Trip.fromJson(data);
      notifyListeners();
    });

    _socket!.on('tripUpdate', (data) {
      final trip = models.Trip.fromJson(data);
      if (trip.status == models.TripStatus.ACCEPTED || trip.status == models.TripStatus.IN_PROGRESS) {
        _currentTrip = trip;
        _incomingRequest = null;
        _status = models.DriverStatus.onTrip;
        notifyListeners();
      } else if (trip.status == models.TripStatus.COMPLETED || trip.status == models.TripStatus.CANCELLED) {
        _currentTrip = null;
        _status = models.DriverStatus.online;
        notifyListeners();
      }
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

    _socket!.on('error', (data) => print('Socket Error: $data'));
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
      final decoded = String.fromCharCodes(base64Decode(payload));
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

  Future<bool> setOnline({double? lat, double? lng}) async {
    _status = models.DriverStatus.online;
    if (lat != null && lng != null) {
      _socket?.emit('goOnline', {'lat': lat, 'lng': lng});
    } else {
      _socket?.emit('goOnline');
    }
    notifyListeners();
    return true;
  }

  void setOffline() {
    _status = models.DriverStatus.offline;
    _socket?.emit('goOffline');
    _currentTrip = null;
    _incomingRequest = null;
    notifyListeners();
  }

  void acceptTrip(String tripId) {
    // Optimistically set _currentTrip from the incoming request so the
    // trip screen doesn't race with the async tripUpdate socket event.
    if (_incomingRequest != null && _incomingRequest!.id == tripId) {
      _currentTrip = _incomingRequest;
      _incomingRequest = null;
      _status = models.DriverStatus.onTrip;
      notifyListeners();
    }
    _socket?.emit('acceptTrip', tripId);
  }

  void cancelTrip(String tripId) {
    _socket?.emit('cancelTrip', tripId);
  }

  void declineTrip(String tripId) {
    _socket?.emit('declineTrip', tripId);
    if (_incomingRequest?.id == tripId) {
      _incomingRequest = null;
      notifyListeners();
    }
  }

  void pickUpRider(String tripId) {
    _socket?.emit('pickUpRider', tripId);
  }

  void completeTrip(String tripId) {
    _socket?.emit('completeTrip', tripId);
  }

  Future<void> rateRide(String rideId, int rating, String reviewText) async {
    await ApiService.rateRide(
      rideId: rideId,
      rating: rating,
      reviewText: reviewText,
    );
  }

  void updateLocation(double lat, double lng, {double heading = 0}) {
    _lastLocation = models.Location(lat: lat, lng: lng);
    _heading = heading;
    _socket?.emit('updateLocation', {'lat': lat, 'lng': lng, 'heading': heading});
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
    if (_socket != null) {
      _socket!.off('');
      _socket!.disconnect();
      _socket!.dispose();
      _socket = null;
    }
    super.dispose();
  }
}
