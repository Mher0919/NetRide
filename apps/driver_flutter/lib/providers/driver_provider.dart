import 'dart:io';
import 'package:flutter/material.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import '../models/trip_models.dart' as models;
import '../services/api_service.dart';
import '../services/user_service.dart';
import '../services/face_verification_service.dart';
import '../services/sound_service.dart';
import '../components/tip_received_dialog.dart';

/// Ordered compliance status for the driver's current blocker (if any).
/// Priority decreases from top to bottom.
enum DriverComplianceStatus {
  /// Driver has submitted profile edits awaiting admin review.
  profileChangePending,

  /// Profile change was recently approved; ephemeral toast.
  profileChangeApproved,

  /// Background check was rejected by admin.
  backgroundCheckRejected,

  /// Background check is pending admin review.
  backgroundCheckPending,

  /// Background check approved but feedback not yet dismissed.
  backgroundCheckApproved,

  /// Face check flagged — under review.
  faceFlagged,

  /// Face check is required before going online.
  faceCheckNeeded,

  /// Admin has requested document resubmission.
  documentActionRequired,

  /// Driver has resubmitted documents; awaiting admin review.
  documentSubmitted,
}

class DriverProvider with ChangeNotifier {
  models.DriverStatus _status = models.DriverStatus.offline;
  models.VehicleClass _activeClass = models.VehicleClass.CORE;
  models.Trip? _currentTrip;
  models.Trip? _incomingRequest;
  IO.Socket? _socket;
  bool _isConnected = false;
  models.Location? _lastLocation;
  double _heading = 0;
  models.Location? _riderLocation;
  List<models.ChatMessage> _messages = [];
  Map<String, dynamic>? _recommendation;

  double _pricePerMile = 2.00;
  double _priceRangeMin = 1.00;
  double _priceRangeMax = 3.00;
  double _recommendedPrice = 2.00;
  DateTime? _priceLastChanged;

  // Face verification state. The app re-checks on boot, on go-online, and
  // when the server pushes a `faceCheckRequired` socket event.
  FaceCheckStatus _faceCheckStatus = FaceCheckStatus.needsCheck;
  String? _faceCheckReason;
  DateTime? _lastFaceCheckAt;
  bool _faceCheckPending = false;

  // Pending profile-change state. When the driver has submitted edits
  // that are awaiting admin review, the offline switch is locked and the
  // availability screen renders a red `profileChangePending` card.
  bool _hasPendingProfileChange = false;
  String? _pendingRequestId;
  DateTime? _pendingSince;
  Map<String, dynamic>? _pendingChangesSummary;
  bool _showApprovedToast = false;

  // Document requirements: admin-requested resubmissions
  bool _hasDocumentActionRequired = false;
  bool _hasDocumentSubmitted = false;
  List<Map<String, dynamic>> _documentRequirements = [];

  // Verification & compliance state (pulled from profile).
  bool _isVerified = false;
  String _verificationStatus = 'PENDING';
  String? _rejectionReason;
  bool _feedbackSeen = true;

  bool get hasDocumentActionRequired => _hasDocumentActionRequired;
  bool get hasDocumentSubmitted => _hasDocumentSubmitted;
  List<Map<String, dynamic>> get documentRequirements => _documentRequirements;

  models.DriverStatus get status => _status;
  models.VehicleClass get activeClass => _activeClass;
  models.Trip? get currentTrip => _currentTrip;
  models.Trip? get incomingRequest => _incomingRequest;
  bool get isConnected => _isConnected;
  models.Location? get lastLocation => _lastLocation;
  double get heading => _heading;
  models.Location? get riderLocation => _riderLocation;
  List<models.ChatMessage> get messages => _messages;
  Map<String, dynamic>? get recommendation => _recommendation;

  /// Underlying socket so the CommunicationService can hook into the
  /// same connection the rest of the trip flow uses.
  IO.Socket? get socket => _socket;

  double get pricePerMile => _pricePerMile;
  double get priceRangeMin => _priceRangeMin;
  double get priceRangeMax => _priceRangeMax;
  double get recommendedPrice => _recommendedPrice;
  DateTime? get priceLastChanged => _priceLastChanged;

  FaceCheckStatus get faceCheckStatus => _faceCheckStatus;
  String? get faceCheckReason => _faceCheckReason;
  DateTime? get lastFaceCheckAt => _lastFaceCheckAt;
  bool get faceCheckPending => _faceCheckPending;

  bool get hasPendingProfileChange => _hasPendingProfileChange;
  String? get pendingRequestId => _pendingRequestId;
  DateTime? get pendingSince => _pendingSince;
  Map<String, dynamic>? get pendingChangesSummary => _pendingChangesSummary;
  bool get showApprovedToast => _showApprovedToast;

  /// True when the driver is free of all blockers and may flip the offline
  /// switch on. The avatar/switch goes disabled otherwise.
  bool get canGoOnline =>
      _isVerified &&
      !_hasPendingProfileChange &&
      !_hasDocumentActionRequired &&
      _faceCheckStatus != FaceCheckStatus.flagged &&
      _faceCheckStatus != FaceCheckStatus.needsCheck;

  /// Resolves the highest-priority blocking status for the driver.
  /// Only returns a non-null status when there is something that
  /// prevents the driver from going online. The caller can use this
  /// to render status cards in priority order.
  DriverComplianceStatus? buildDriverComplianceStatus() {
    // 1. Profile change pending — highest priority
    if (_hasPendingProfileChange) return DriverComplianceStatus.profileChangePending;

    // 2. Background check rejected
    if (_verificationStatus == 'REJECTED') return DriverComplianceStatus.backgroundCheckRejected;

    // 3. Background check pending
    if (_verificationStatus == 'PENDING') return DriverComplianceStatus.backgroundCheckPending;

    // 4. Background check approved but feedback not yet dismissed
    if (_verificationStatus == 'APPROVED' && !_feedbackSeen) return DriverComplianceStatus.backgroundCheckApproved;

    // 5. Face check flagged
    if (_faceCheckStatus == FaceCheckStatus.flagged) return DriverComplianceStatus.faceFlagged;

    // 6. Face check required
    if (_faceCheckStatus == FaceCheckStatus.needsCheck && _faceCheckPending) return DriverComplianceStatus.faceCheckNeeded;

    // 7. Document action required
    if (_hasDocumentActionRequired) return DriverComplianceStatus.documentActionRequired;

    // 8. Document submitted for review (informational, not a blocker)
    if (_hasDocumentSubmitted) return DriverComplianceStatus.documentSubmitted;

    // 9. No blockers — profile-change approved toast (informational, ephemeral)
    if (_showApprovedToast) return DriverComplianceStatus.profileChangeApproved;

    // No blockers, driver is ready
    return null;
  }

  void updateToken(String token) {
    initSocket(token);
    _fetchOperatingClass();
    _fetchRecommendations();
    fetchPricing();
  }

  Future<void> fetchPricing() async {
    try {
      final response = await ApiService.dio.get('/driver/pricing');
      final data = response.data;
      _pricePerMile = (data['price_per_mile'] as num).toDouble();
      _priceRangeMin = (data['price_range_min'] as num).toDouble();
      _priceRangeMax = (data['price_range_max'] as num).toDouble();
      _recommendedPrice = (data['recommended_price'] as num).toDouble();
      if (data['price_last_changed'] != null) {
        _priceLastChanged = DateTime.parse(data['price_last_changed']);
      }
      notifyListeners();
    } catch (e) {
      debugPrint('Error fetching pricing: $e');
    }
  }

  Future<void> updatePrice(double newPrice) async {
    try {
      final response = await ApiService.dio.post('/driver/pricing/update', data: {
        'pricePerMile': newPrice,
      });
      final data = response.data;
      _pricePerMile = (data['price_per_mile'] as num).toDouble();
      _priceRangeMin = (data['price_range_min'] as num).toDouble();
      _priceRangeMax = (data['price_range_max'] as num).toDouble();
      _recommendedPrice = (data['recommended_price'] as num).toDouble();
      if (data['price_last_changed'] != null) {
        _priceLastChanged = DateTime.parse(data['price_last_changed']);
      }
      notifyListeners();
    } catch (e) {
      debugPrint('Error updating price: $e');
      rethrow;
    }
  }

  Future<void> _fetchOperatingClass() async {
    try {
      final profile = await UserService.getProfile();
      if (profile['active_class'] != null) {
        _activeClass = models.VehicleClass.values.firstWhere(
          (e) => e.toString().split('.').last == profile['active_class'],
          orElse: () => models.VehicleClass.CORE,
        );
        notifyListeners();
      }
    } catch (e) {
      debugPrint('Error fetching operating class: $e');
    }
  }

  Future<void> updateOperatingClass(models.VehicleClass newClass) async {
    try {
      final className = newClass.toString().split('.').last;
      await ApiService.dio.patch('/driver/operating-class', data: {'activeClass': className});
      _activeClass = newClass;
      notifyListeners();
    } catch (e) {
      debugPrint('Error updating operating class: $e');
      rethrow;
    }
  }

  Future<void> _fetchRecommendations() async {
    try {
      final response = await ApiService.dio.get('/driver/recommendations');
      _recommendation = response.data;
      notifyListeners();
    } catch (e) {
      debugPrint('Error fetching recommendations: $e');
    }
  }

  void initSocket(String token) {
    if (_socket != null) {
      _socket!.off('');
      _socket!.disconnect();
      _socket!.dispose();
      _socket = null;
    }
    final url = 'https://netride.onrender.com';
    print('--- DRIVER SOCKET INIT ---');
    print('URL: $url');
    print('Token: $token');
    print('--------------------------');

    _socket = IO.io(url, IO.OptionBuilder()
      .setTransports(['websocket']) // Force websocket
      .enableForceNew()
      .enableReconnection()
      .setAuth({
        'token': token,
        'role': 'driver'
      })
      .build());

    _socket!.onConnect((_) {
      print('Driver connected to socket');
      _isConnected = true;
      notifyListeners();
    });

    _socket!.onDisconnect((_) {
      print('Driver disconnected from socket');
      _isConnected = false;
      notifyListeners();
    });

    _socket!.onConnectError((err) {
      print('Driver Connect Error: $err');
      _isConnected = false;
      notifyListeners();
    });

    _socket!.on('newTripRequest', (data) {
      _incomingRequest = models.Trip.fromJson(data);
      notifyListeners();
    });

    _socket!.on('pricingUpdate', (data) {
      _pricePerMile = (data['price_per_mile'] as num).toDouble();
      _priceRangeMin = (data['price_range_min'] as num).toDouble();
      _priceRangeMax = (data['price_range_max'] as num).toDouble();
      _recommendedPrice = (data['recommended_price'] as num).toDouble();
      if (data['price_last_changed'] != null) {
        _priceLastChanged = DateTime.parse(data['price_last_changed']);
      }
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

    // ----- Navigation lifecycle events ----------------------------------
    // These are pushed by the server (NavigationService emitters) when
    // the trip transitions between pickup → destination, when a manual
    // reroute completes, or when a rider-side destination change
    // forces a re-route. The NavigationScreen consumes them by reading
    // NavigationService directly; the driver app simply forwards.
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
        debugPrint('[NAV] leg advanced → destination for $tripId');
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

    _socket!.on('faceCheckRequired', (data) {
      // The server pushed a face-check gate (either an attempt to go
      // online was blocked, or the admin just cleared something and we
      // need a fresh re-check). Update local state so the UI routes to
      // the capture screen.
      try {
        final decision = FaceCheckDecision.fromJson(
          Map<String, dynamic>.from(data as Map),
        );
        _faceCheckStatus = decision.status;
        _faceCheckReason = decision.reason.toString().split('.').last;
        _lastFaceCheckAt = decision.lastFaceCheckAt;
        _faceCheckPending = decision.required;
        notifyListeners();
      } catch (e) {
        debugPrint('Bad faceCheckRequired payload: $e');
      }
    });

    _socket!.on('faceCheckStatusChanged', (data) {
      // Admin cleared/rejected a flagged event in real time.
      final status = (data as Map)['status']?.toString();
      if (status == 'CLEAR') {
        _faceCheckStatus = FaceCheckStatus.clear;
        _faceCheckPending = false;
      } else if (status == 'FLAGGED') {
        _faceCheckStatus = FaceCheckStatus.flagged;
        _faceCheckPending = true;
        _faceCheckReason = 'flagged';
      }
      notifyListeners();
    });

    _socket!.on('profileChangeReviewed', (data) async {
      // Admin reviewed a profile-change request. Refresh from the server
      // so the offline switch unlocks / re-locks based on the latest
      // `has_pending_profile_change` flag. Also surface a brief green
      // toast when the request was approved so the driver knows the
      // changes are live.
      try {
        final map = Map<String, dynamic>.from(data as Map);
        final decision = map['decision']?.toString();
        await refreshProfile();
        if (decision == 'APPROVED') {
          _showApprovedToast = true;
          notifyListeners();
        } else if (decision == 'REJECTED') {
          // Rejection emails the driver — just re-render to drop the red
          // card. Reason is in the email body.
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

  /// Re-fetch the current face-check gate from the server and update the
  /// local state. Called on app boot and right before toggling online.
  Future<FaceCheckDecision> refreshFaceCheck({double? lat, double? lng}) async {
    try {
      final decision = await FaceVerificationService.isCheckRequired(
        lat: lat,
        lng: lng,
      );
      _faceCheckStatus = decision.status;
      _faceCheckReason = decision.reason.toString().split('.').last;
      _lastFaceCheckAt = decision.lastFaceCheckAt;
      _faceCheckPending = decision.required;
      notifyListeners();
      return decision;
    } catch (e) {
      debugPrint('refreshFaceCheck failed: $e');
      rethrow;
    }
  }

  /// Called after a successful face capture completes. Lifts the local
  /// flag so the UI can immediately route back to the offline switch.
  void markFaceCheckPassed({DateTime? at}) {
    _faceCheckStatus = FaceCheckStatus.clear;
    _faceCheckReason = null;
    _faceCheckPending = false;
    _lastFaceCheckAt = at ?? DateTime.now();
    notifyListeners();
  }

  /// Called when the capture screen reports a flagged result so the
  /// banner can flip to the red "under review" state without another
  /// round trip.
  void markFaceCheckFlagged(String reason) {
    _faceCheckStatus = FaceCheckStatus.flagged;
    _faceCheckReason = reason;
    _faceCheckPending = true;
    notifyListeners();
  }

  /// Pulls the latest profile (incl. `has_pending_profile_change`) from
  /// the server. Called on app boot, after submitting a profile change,
  /// and when the server pushes `profileChangeReviewed`.
  Future<Map<String, dynamic>> refreshProfile() async {
    final profile = await UserService.getProfile();
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

    // Store verification state from profile
    _verificationStatus = (profile['background_check_status'] ?? 'PENDING').toString();
    _rejectionReason = profile['rejection_reason']?.toString();
    _feedbackSeen = profile['verification_feedback_seen'] == true;
    _isVerified = profile['is_active'] == true || profile['is_active'] == 'true';

    // Also refresh document requirements state
    try {
      final docReqs = await UserService.getDocumentRequirements();
      final reqs = (docReqs['requirements'] as List?) ?? [];
      _documentRequirements = reqs.map((r) => Map<String, dynamic>.from(r as Map)).toList();
      _hasDocumentActionRequired = reqs.any((r) =>
          (r as Map)['status'] == 'resubmission_required');
      _hasDocumentSubmitted = reqs.any((r) =>
          (r as Map)['status'] == 'submitted');
    } catch (_) {
      // Non-fatal
    }

    notifyListeners();
    return profile;
  }

  /// Acknowledge the brief "approved" toast — the availability screen
  /// calls this after dismissing the green card so the flag doesn't
  /// re-trigger on every rebuild.
  void markProfileChangeApprovedShown() {
    _showApprovedToast = false;
    notifyListeners();
  }

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

  /// Returns true if the driver was sent online. Returns false when the
  /// server told us a face check is required — caller should route into
  /// the capture screen. Throws on transport errors.
  Future<bool> setOnline({double? lat, double? lng}) async {
    try {
      final decision = await refreshFaceCheck(lat: lat, lng: lng);
      if (decision.required) {
        _faceCheckPending = true;
        _faceCheckReason = decision.reason.toString().split('.').last;
        notifyListeners();
        return false;
      }
    } catch (_) {
      // Transport failure — let the socket-level gate catch it; we still
      // emit `goOnline` so the server has the final word.
    }

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
    _socket?.emit('acceptTrip', tripId);
  }

  /// Driver rejected the incoming request. Clears the local UI and notifies
  /// the backend so it can dispatch to the next driver immediately instead
  /// of waiting for the 15s accept timeout to elapse.
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
