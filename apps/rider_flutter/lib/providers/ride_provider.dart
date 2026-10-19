import 'dart:async';
import '../services/secure_token_store.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:latlong2/latlong.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'package:uuid/uuid.dart';
import '../models/trip_models.dart';
import '../services/api_service.dart';
import '../services/sound_service.dart';

class RideProvider with ChangeNotifier {
  /// Persisted active-trip id. On a COLD app start (process killed), the
  /// rider side re-attaches to the authoritative server state via
  /// `getCurrentTrip` — otherwise the rider app would silently "forget"
  /// an in-flight ride while the driver app (which always resyncs on
  /// connect) keeps routing to it. Cleared the moment the trip settles.
  static const _activeTripKey = 'active_trip_id';
  TripStatus _status = TripStatus.IDLE;
  String? _tripId;
  DriverInfo? _driver;
  double? _estimatedFare;
  IO.Socket? _socket;
  bool _isConnected = false;
  Trip? _currentTrip;
  List<ChatMessage> _messages = [];
  final Map<String, Location> _nearbyDrivers = {};
  bool _cancelling = false;

  /// Idempotency key for the CURRENT logical ride request. Reused across
  /// every retry (double tap, ack timeout, unknown outcome) so the server
  /// can never create a second ride from the same intent; cleared once the
  /// request is confirmed or the ride settles.
  String? _requestKey;

  /// The exact payload of the pending ride request, kept for safe retries
  /// and for reconciling an unknown outcome (ack timeout) against the REST
  /// endpoint with the same idempotency key.
  Map<String, dynamic>? _lastRequestPayload;

  /// Bounded ack timeout: the request stays "pending" until the first
  /// authoritative tripUpdate arrives. On expiry the rider sees an honest
  /// unknown-outcome state (retry reuses the same key).
  Timer? _requestAckTimer;
  bool _awaitingServerAck = false;

  /// Trip ids that already reached a terminal state. Late/duplicate events
  /// for them are ignored (bounded below in [_settleTripId]).
  final Set<String> _settledTripIds = {};

  /// Server version of the tracked trip (`updated_at`) for out-of-order
  /// event suppression.
  DateTime? _currentTripUpdatedAt;

  /// True while the request mutation is awaiting the authoritative server
  /// acknowledgement (first tripUpdate). The UI must not claim success while
  /// this is true.
  bool get awaitingServerAck => _awaitingServerAck;

  /// Last rider position sent to the gateway. Used to attribute activity
  /// signals (REQUEST_FLOW / APP_ACTIVE) with a real location.
  Location? _lastKnownLocation;

  /// Broadcast ping when the backend records a new notification for this
  /// rider (socket `notificationReceived`). The notifications screen listens
  /// to refresh its list live without polling.
  final StreamController<void> _notificationPing =
      StreamController<void>.broadcast();
  Stream<void> get notificationPing => _notificationPing.stream;

  /// Live SPECIALS redemption updates pushed by the backend
  /// (`specialRedemptionUpdate`). The SPECIALS screen listens to re-render
  /// the active redemption card the instant the sponsor validates the code
  /// or the reward is processed.
  final StreamController<Map<String, dynamic>> _specialRedemptionUpdates =
      StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get specialRedemptionUpdates =>
      _specialRedemptionUpdates.stream;

  /// Authoritative route pushed by the backend (navigationStarted /
  /// navigationRerouteRequested). Rendering this — instead of calling
  /// the routing API from the trip screen — keeps the rider map in sync
  /// with the driver's actual route without any extra Google calls.
  List<LatLng>? _navigationRoute;
  double? _navigationEtaSeconds;
  bool _navigationCacheHit = false;

  /// Live ETA pushed by the gateway (10 s throttled) while the driver
  /// is en route.
  double? _driverEtaSeconds;
  int? _driverRemainingMeters;

  /// True when the backend detects the assigned driver's app stopped
  /// reporting while the ride is active (heartbeat expired). The trip screen
  /// renders a "we're monitoring" banner; it is cleared automatically when
  /// the driver reports again. Defaults to connected.
  bool _driverOffline = false;
  bool get driverOffline => _driverOffline;

  TripStatus get status => _status;
  String? get tripId => _tripId;
  DriverInfo? get driver => _driver;
  double? get estimatedFare => _estimatedFare;
  bool get isConnected => _isConnected;
  Trip? get currentTrip => _currentTrip;
  List<ChatMessage> get messages => _messages;
  Map<String, Location> get nearbyDrivers => _nearbyDrivers;
  List<LatLng>? get navigationRoute => _navigationRoute;
  double? get navigationEtaSeconds => _navigationEtaSeconds;
  bool get navigationCacheHit => _navigationCacheHit;
  double? get driverEtaSeconds => _driverEtaSeconds;
  int? get driverRemainingMeters => _driverRemainingMeters;
  bool get cancelling => _cancelling;

  /// Exposed so the CommunicationService can hook into the same socket
  /// the rest of the ride flow uses. Returns null if the socket hasn't
  /// been initialised yet (e.g. user is still on the splash screen).
  IO.Socket? get socket => _socket;

  /// Server notice that the assigned driver cancelled AFTER accepting but
  /// BEFORE pickup (pre-pickup release): the backend already flipped the
  /// SAME ride (same fare quote, promo + credits) back to searching and
  /// re-dispatched it, so the rider keeps searching at the same price.
  /// Holds the apology payload until the active screen consumes and
  /// renders it exactly once.
  Map<String, dynamic>? _driverCancelledNotice;
  Map<String, dynamic>? get driverCancelledNotice => _driverCancelledNotice;

  /// Monotonic id per received notice so screens can pop one apology per
  /// driver cancellation even when the same trip is released repeatedly
  /// (no UI re-entry, but a fresh apology every time).
  int _driverCancelledNoticeSeq = 0;
  int get driverCancelledNoticeSeq => _driverCancelledNoticeSeq;

  /// Last request-level failure pushed by the backend socket `error` event
  /// (e.g. "This special is temporarily unavailable"). The map screen
  /// surfaces this instead of leaving the rider stuck on "Finding your
  /// driver…". Cleared on the next successful request.
  String? _requestFailure;
  String? get requestFailure => _requestFailure;

  /// Server signaled that a saved payment method is required before booking.
  bool _paymentMethodRequired = false;
  bool get paymentMethodRequired => _paymentMethodRequired;

  /// Consumed by the map screen after it navigates the rider to add a card.
  void consumePaymentMethodRequired() {
    _paymentMethodRequired = false;
    notifyListeners();
  }

  /// Dismiss the last request failure (the rider closed the error card).
  void clearRequestFailure() {
    if (_requestFailure == null) return;
    _requestFailure = null;
    notifyListeners();
  }

  /// True while the rider has an active ride request that the backend is
  /// still matching (initial request OR re-match after a driver cancel).
  /// The ONE predicate the map screen uses to keep the existing search UI
  /// alive across both flows.
  bool get isSearchingForDriver =>
      _status == TripStatus.REQUESTED && _tripId != null;

  /// True while a driver is assigned but the trip has not started:
  /// ACCEPTED (en route to pickup) or DRIVER_ARRIVING (at pickup).
  bool get isPrePickup =>
      _status == TripStatus.ACCEPTED ||
      _status == TripStatus.DRIVER_ARRIVING;

  /// Hot-swap the auth token (fresh login) and rebuild the socket against it.
  void updateToken(String token) => initSocket(token);

  /// The idempotency key of the pending request intent (null when no
  /// request is in flight or unsettled). Exposed for tests asserting that
  /// retries reuse one key.
  @visibleForTesting
  String? get pendingRequestKey => _requestKey;

  /// Consumed by whichever screen is in front (map sheet or trip screen)
  /// so the apology popup appears exactly once per driver cancellation.
  Map<String, dynamic>? consumeDriverCancelledNotice() {
    final notice = _driverCancelledNotice;
    _driverCancelledNotice = null;
    return notice;
  }

  void subscribeToNearbyDrivers(Location loc) {
    _socket?.emit('subscribeToNearbyDrivers', loc.toJson());
  }

  void initSocket(String token) {
    // Socket base URL is derived once in ApiService so HTTP and WebSocket
    // gateways can never drift. Tokens are intentionally NOT logged (OWASP:
    // a JWT prefix leaks the signing algorithm header).
    final socketUrl = ApiService.socketBaseUrl;
    debugPrint('--- SOCKET INIT --- URL=$socketUrl token=<redacted>');

    _socket = IO.io(socketUrl, <String, dynamic>{
      // Negotiation order: WebSocket first (low-latency), then polling as
      // fallback (works through HTTP proxies that block ws upgrades). This
      // mirrors socket.io-client defaults and avoids the Android-emulator
      // "Failed host lookup" that the previous forced-websocket transport
      // masked.
      'transports': ['websocket', 'polling'],
      'forceNew': true, // Ensure fresh connection
      'reconnection': true,
      'reconnectionAttempts': double.infinity,
      'reconnectionDelay': 1000,
      'reconnectionDelayMax': 15000,
      'randomizationFactor': 0.5,
      'auth': {'token': token, 'role': 'RIDER'},
    });

    _socket!.onConnect((_) {
      debugPrint(
        '[SOCKET] Rider connected URL=$socketUrl transport=${_socket?.io.engine?.transport?.name ?? '?'}',
      );
      _isConnected = true;
      notifyListeners();
      // Reconnect resync: if a trip is pending (REQUESTED/ACCEPTED/
      // IN_PROGRESS), re-ask the server for the authoritative state. A
      // socket blip right around the ACCEPTED broadcast otherwise leaves
      // the rider stuck on "searching" forever — the tripUpdate is not
      // replayed automatically.
      if (_status != TripStatus.IDLE && _tripId != null) {
        debugPrint(
          '[RIDE] Resyncing current trip (status=$_status) after reconnect',
        );
        _socket?.emit('getCurrentTrip');
      }
      // Cold-start restore: the process was killed mid-trip. Re-attach to
      // the persisted trip so rider and driver sides stay in agreement
      // instead of the rider silently dropping out of an active journey.
      _restoreActiveTripAfterRestart();
      // REST hydration is the socket-independent recovery path: it also
      // covers a killed app that never received a first tripUpdate (no
      // persisted id yet) and re-reads the authoritative ride over HTTP.
      hydrateFromServer();
    });

    _socket!.on('currentTripNone', (data) {
      // Authoritative answer to getCurrentTrip: no active trip. Only act
      // when we believe we have one — the server may have cancelled it
      // while we were disconnected. Settle the id first so a late stale
      // ACCEPTED event can never resurrect it.
      if (_status != TripStatus.IDLE && _tripId != null) {
        debugPrint(
          '[RIDE] Server reports no current trip — clearing stale local state',
        );
        _settleTripId(_tripId!);
        reset();
      }
    });

    _socket!.onDisconnect((reason) {
      debugPrint('[SOCKET] Rider disconnected URL=$socketUrl reason=$reason');
      _isConnected = false;
      notifyListeners();
    });

    _socket!.onConnectError((err) {
      // Log the actual URL and the raw error — the previous version hardcoded
      // a misleading "DNS resolution failed for netride.onrender.com" message
      // regardless of the real cause, which made it impossible to tell a DNS
      // failure from a blocked WebSocket upgrade or a wrong path.
      debugPrint('[SOCKET] Rider connect error URL=$socketUrl raw=$err');
      _isConnected = false;
      notifyListeners();
    });

    _socket!.on('tripUpdate', (data) {
      if (data is! Map) return;
      applyTripUpdate(
        Trip.fromJson(Map<String, dynamic>.from(data)),
        Map<String, dynamic>.from(data),
      );
    });

    // Driver cancelled after accepting but BEFORE pickup: the backend
    // releases the SAME ride (same fare quote / promo / credits) back to
    // REQUESTED, re-dispatches it, and sends this apology notice. Forget
    // the departing driver so the next ACCEPTED builds fresh identity,
    // and let the active screen pop the apology dialog once.
    _socket!.on('tripDriverCancelled', (data) {
      debugPrint(
        '[RIDE] tripDriverCancelled → ride released + re-matching (same ride)',
      );
      if (data is! Map<String, dynamic>) return;
      _driver = null;
      _navigationRoute = null;
      _navigationEtaSeconds = null;
      _driverEtaSeconds = null;
      _driverRemainingMeters = null;
      _driverCancelledNoticeSeq += 1;
      _driverCancelledNotice = {...data, 'noticeId': _driverCancelledNoticeSeq};
      notifyListeners();
    });

    _socket!.on('driverLocationUpdate', (data) {
      final driverId = data['driverId'];
      final loc = Location.fromJson(data);

      if (_driver != null && _driver!.id == driverId) {
        _driver = DriverInfo(
          id: _driver!.id,
          name: _driver!.name,
          vehicle: _driver!.vehicle,
          plate: _driver!.plate,
          location: loc,
        );
      } else {
        // It's a nearby available driver
        _nearbyDrivers[driverId!] = loc;
      }
      notifyListeners();
    });

    _socket!.on('messageReceived', (data) {
      final msg = ChatMessage.fromJson(data);
      _messages.add(msg);
      notifyListeners();
    });

    _socket!.on('navigationStarted', (data) {
      _setNavigationRoute(data);
    });

    _socket!.on('navigationLegAdvanced', (data) {
      _setNavigationRoute(data);
    });

    _socket!.on('navigationRerouteRequested', (data) {
      _setNavigationRoute(data);
    });

    _socket!.on('driverEtaUpdate', (data) {
      if (data is! Map) return;
      if (data['tripId'] != null && data['tripId'] != _tripId) return;
      _driverEtaSeconds = (data['etaSeconds'] as num?)?.toDouble();
      _driverRemainingMeters = (data['remainingMeters'] as num?)?.toInt();
      notifyListeners();
    });

    // Driver-connectivity watchdog: the backend flags an active ride whose
    // driver's app stopped reporting (and clears the flag on recovery).
    // Surfaced as a monitoring banner so the rider is never left staring at
    // a silently frozen marker.
    _socket!.on('driverConnectivity', (data) {
      if (data is! Map) return;
      applyDriverConnectivity(Map<String, dynamic>.from(data));
    });

    _socket!.on('navigationEnded', (data) {
      _navigationRoute = null;
      _navigationEtaSeconds = null;
      _driverEtaSeconds = null;
      _driverRemainingMeters = null;
      notifyListeners();
    });

    _socket!.on('tipReceived', (data) {
      try {
        SoundService.instance.play(SoundEffect.tipReceived);
      } catch (e) {
        print('Error playing tip sound: $e');
      }
    });

    // A new push was recorded for this rider (deduped server-side). The
    // notifications screen uses this to refresh instead of polling.
    _socket!.on('notificationReceived', (data) {
      debugPrint(
        '[RIDE] notificationReceived → ${data is Map ? data['type'] : data}',
      );
      if (!_notificationPing.isClosed) _notificationPing.add(null);
    });

    // Sponsorship/SPECIALS: the backend pushes a live card whenever the
    // redemption transitions (ride pending → code issued → sponsor
    // validated → reward processed). The SPECIALS screen refetches state.
    _socket!.on('specialRedemptionUpdate', (data) {
      debugPrint(
        '[RIDE] specialRedemptionUpdate → ${data is Map ? data['status'] : data}',
      );
      if (data is Map<String, dynamic>) _specialRedemptionUpdates.add(data);
    });

    // A ride request was REJECTED server-side (e.g. the special is no longer
    // attachable). Never a silent hang: the searching sheet reads this and
    // tells the rider what happened.
    _socket!.on('error', (data) {
      debugPrint('[RIDE] Socket error: $data');
      // Single-active-ride guard: the server refused a duplicate request
      // and pointed at the existing ride. Re-hydrate it instead of showing
      // a failure — the app may have been killed before the first
      // tripUpdate and have no local trip id.
      if (data is Map && data['code'] == 'ACTIVE_RIDE_EXISTS') {
        debugPrint('[RIDE] Active ride exists — hydrating the existing ride');
        _requestAckTimer?.cancel();
        _requestAckTimer = null;
        _awaitingServerAck = false;
        notifyListeners();
        hydrateFromServer();
        return;
      }
      final msg = data is String
          ? data
          : (data is Map && data['message'] is String)
          ? data['message'] as String
          : 'Your ride request could not be sent. Please try again.';
      _requestFailure = msg;
      // The server answered (rejection): stop waiting for the ack, but keep
      // the idempotency key so a retry of the same intent is safe.
      _requestAckTimer?.cancel();
      _requestAckTimer = null;
      _awaitingServerAck = false;
      notifyListeners();
    });

    // Booking gate: no saved payment method. The map screen listens for
    // this and navigates the rider to the Payment Method page to add a card.
    _socket!.on('paymentMethodRequired', (data) {
      debugPrint('[RIDE] paymentMethodRequired: $data');
      _paymentMethodRequired = true;
      _requestFailure = null;
      _requestAckTimer?.cancel();
      _requestAckTimer = null;
      _awaitingServerAck = false;
      _requestKey = null;
      _lastRequestPayload = null;
      _status = TripStatus.IDLE;
      notifyListeners();
    });

    // Cancellation rejected server-side (e.g. missing reason / not in a
    // cancellable state). The REST confirm path surfaces the same message
    // when the socket one arrived first — never a silent hang.
    _socket!.on('cancelTripFailed', (data) {
      debugPrint('[RIDE] Server rejected cancellation: $data');
    });
  }

  /// Applies an authoritative trip payload exactly once, in order. Shared by
  /// the socket broadcast path, the REST request fallback and cold-start
  /// hydration so both funnel through the same guards:
  ///   1. settled trip ids are ignored (late terminal duplicates),
  ///   2. IDLE resets reject every stale resurrection (except authoritative
  ///      hydration, which is exactly the payload that ends IDLE),
  ///   3. a different ride id never replaces the tracked ride,
  ///   4. an older server version (`updated_at`) never overwrites a newer one.
  @visibleForTesting
  void applyTripUpdate(Trip trip, [Map<String, dynamic>? raw, bool fromHydration = false]) {
    final oldStatus = _status;
    final data = raw ?? const <String, dynamic>{};

    if (_settledTripIds.contains(trip.id)) {
      debugPrint('[RIDE] Ignoring tripUpdate for settled trip ${trip.id}');
      return;
    }
    if (_status == TripStatus.IDLE && !fromHydration) {
      debugPrint(
        '[RIDE] Ignoring stale ${trip.status} tripUpdate while IDLE (trip ${trip.id})',
      );
      return;
    }
    if (_tripId != null && trip.id != _tripId) {
      debugPrint(
        '[RIDE] Ignoring tripUpdate for different trip ${trip.id} (current: $_tripId)',
      );
      return;
    }
    final incomingVersion = trip.updatedAt;
    if (incomingVersion != null &&
        _currentTripUpdatedAt != null &&
        trip.id == _tripId &&
        incomingVersion.isBefore(_currentTripUpdatedAt!)) {
      debugPrint(
        '[RIDE] Ignoring out-of-order tripUpdate (v=$incomingVersion < $_currentTripUpdatedAt)',
      );
      return;
    }

    // The server answered: the request ack is settled (success path).
    _requestAckTimer?.cancel();
    _requestAckTimer = null;
    _awaitingServerAck = false;
    _requestKey = null;
    _lastRequestPayload = null;

    _currentTrip = trip;
    _currentTripUpdatedAt = incomingVersion;
    _status = trip.status;
    _tripId = trip.id;

    // Connectivity state belongs to the CURRENT assigned driver only.
    if (trip.status == TripStatus.REQUESTED ||
        trip.status == TripStatus.CANCELLED ||
        trip.status == TripStatus.COMPLETED) {
      _driverOffline = false;
    }

    // Back to searching (driver released / rider's request still being
    // matched): the departing driver's identity and route context are
    // gone — the riding side rebuilds them on the next ACCEPTED.
    if (trip.status == TripStatus.REQUESTED && _driver != null) {
      _driver = null;
      _navigationRoute = null;
      _navigationEtaSeconds = null;
      _driverEtaSeconds = null;
      _driverRemainingMeters = null;
    }

    // Chat dies with the ride (spec §16): no new messages, no stale
    // bubbles surviving the transition.
    if (trip.status == TripStatus.CANCELLED) {
      _messages = [];
    }

    // Persist the active trip for cold-start restore; drop the marker and
    // release the trip id the instant the ride reaches a terminal state so
    // a later reboot — or the next request — starts clean.
    if (trip.status == TripStatus.CANCELLED ||
        trip.status == TripStatus.COMPLETED) {
      _persistActiveTrip(null);
      _settleTripId(trip.id);
      _tripId = null;
      _currentTripUpdatedAt = null;
    } else {
      _persistActiveTrip(trip.id);
    }

    if (oldStatus == TripStatus.REQUESTED &&
        trip.status == TripStatus.ACCEPTED) {
      SoundService.instance.play(SoundEffect.orderAccepted);
    }
    if (oldStatus != TripStatus.CANCELLED &&
        trip.status == TripStatus.CANCELLED) {
      SoundService.instance.play(SoundEffect.orderCancelled);
    }
    if (oldStatus != TripStatus.COMPLETED &&
        trip.status == TripStatus.COMPLETED) {
      SoundService.instance.play(SoundEffect.tripCompleted);
    }

    if (trip.status == TripStatus.ACCEPTED ||
        trip.status == TripStatus.DRIVER_ARRIVING ||
        trip.status == TripStatus.IN_PROGRESS) {
      Location? initialLoc;
      if (data['driver_location'] != null) {
        initialLoc = Location.fromJson(data['driver_location']);
      }

      // Real driver identity from the authoritative payload. The map
      // carries driver_info.{name,vehicle,plate} from the users +
      // driver_vehicles tables — never fabricated client-side. Fields
      // absent from the payload stay null and the UI hides them.
      final driverInfo = trip.driverInfo;
      if (_driver == null) {
        _driver = DriverInfo(
          id: trip.driverId ?? '',
          name: driverInfo?.name ?? '',
          vehicle: driverInfo?.vehicle,
          plate: driverInfo?.plate,
          location: initialLoc,
        );
      } else {
        _driver = DriverInfo(
          id: _driver!.id.isNotEmpty ? _driver!.id : (trip.driverId ?? ''),
          name: _driver!.name,
          vehicle: _driver!.vehicle,
          plate: _driver!.plate,
          location: initialLoc ?? _driver!.location,
        );
      }
    }
    // Cold-start recovery must also restore the route the driver is
    // following (the socket-only navigation events are never replayed).
    if (fromHydration &&
        _navigationRoute == null &&
        (trip.status == TripStatus.ACCEPTED ||
            trip.status == TripStatus.DRIVER_ARRIVING ||
            trip.status == TripStatus.IN_PROGRESS)) {
      _replayNavigationRoute(trip);
    }
    notifyListeners();
  }

  /// Records a terminal trip id so late/duplicate events can never resurrect
  /// it. Bounded: oldest entries are dropped beyond 50.
  void _settleTripId(String tripId) {
    _settledTripIds.add(tripId);
    while (_settledTripIds.length > 50) {
      _settledTripIds.remove(_settledTripIds.first);
    }
  }

  void sendMessage(String tripId, String message) {
    _socket?.emit('sendMessage', {'tripId': tripId, 'message': message});
    _messages.add(
      ChatMessage(
        senderId: 'me',
        role: 'rider',
        message: message,
        timestamp: DateTime.now(),
      ),
    );
    notifyListeners();
  }

  void clearMessages() {
    _messages = [];
    notifyListeners();
  }

  void requestRide(
    Location pickup,
    Location destination, {
    bool isScheduled = false,
    DateTime? scheduledAt,
    bool favoritePriority = false,
    String? idempotencyKey,
    String? promoCode,
    bool applyCredits = false,
    int? creditUseCents,
    String? specialRedemptionId,
    bool specialTermsAccepted = false,
  }) {
    debugPrint(
      '[RIDE] requestRide called | socket=${_socket != null} connected=${_socket?.connected} pickup=${pickup.lat},${pickup.lng} dest=${destination.lat},${destination.lng}',
    );

    // A request that is already being matched must never be duplicated by a
    // double tap or a re-entrant caller. The retry path (no trip id yet)
    // falls through and reuses the same idempotency key.
    if (isSearchingForDriver) {
      debugPrint('[RIDE] requestRide ignored — already matching $_tripId');
      return;
    }
    _prepareForNewRequest();

    // One stable key per logical ride intent: identical retries resolve to
    // the SAME server-side ride (unique rides.idempotency_key) instead of
    // creating another one.
    _requestKey ??= idempotencyKey ?? const Uuid().v4();
    final key = idempotencyKey ?? _requestKey!;
    final cleanedPromo = promoCode?.trim();

    final payload = <String, dynamic>{
      'pickup': pickup.toJson(),
      'destination': destination.toJson(),
      'isScheduled': isScheduled,
      if (scheduledAt != null) 'scheduledAt': scheduledAt.toIso8601String(),
      'favoritePriority': favoritePriority,
      'idempotencyKey': key,
      if (cleanedPromo != null && cleanedPromo.isNotEmpty)
        'promoCode': cleanedPromo.toUpperCase(),
      'applyCredits': applyCredits,
      if (creditUseCents != null && creditUseCents > 0)
        'creditUseCents': creditUseCents,
      if (specialRedemptionId != null && specialRedemptionId.isNotEmpty)
        'specialRedemptionId': specialRedemptionId,
      // Explicit consent to the conditional no-show additional charge
      // (server-enforced; the ride request fails without it).
      if (specialRedemptionId != null && specialRedemptionId.isNotEmpty)
        'specialTermsAccepted': specialTermsAccepted,
    };

    _requestFailure = null;
    _awaitingServerAck = true;
    _lastRequestPayload = payload;
    if (!isScheduled) {
      _status = TripStatus.REQUESTED;
    }
    notifyListeners();

    if (_socket != null && _socket!.connected) {
      _socket!.emit('requestRide', payload);
      _armRequestAckTimer(key);
    } else {
      // No live socket (e.g. the socket was never initialized after a
      // password login). Fall back to the REST endpoint with the identical
      // payload + idempotency key instead of silently dropping the request.
      debugPrint('[RIDE] Socket unavailable — requesting via REST fallback');
      _requestRideViaRest(payload, key);
    }
  }

  /// Re-issues the pending request after an unknown outcome or a surfaced
  /// failure. Always uses the SAME idempotency key: if the first attempt
  /// actually reached the server, this resolves to the same ride (never a
  /// duplicate), otherwise it creates the intended one.
  Future<void> retryPendingRequest() async {
    final key = _requestKey;
    final payload = _lastRequestPayload;
    if (key == null || payload == null) return;
    if (isSearchingForDriver) return;
    _requestFailure = null;
    _awaitingServerAck = true;
    notifyListeners();
    if (_socket != null && _socket!.connected) {
      _socket!.emit('requestRide', payload);
      _armRequestAckTimer(key);
    } else {
      await _requestRideViaRest(payload, key);
    }
  }

  /// Clears state that belongs to a PREVIOUS logical request. A retry of an
  /// unconfirmed request (REQUESTED with no server trip id yet) keeps its
  /// key and pending state.
  void _prepareForNewRequest() {
    if (_status == TripStatus.REQUESTED && _tripId == null) return;
    _currentTrip = null;
    _currentTripUpdatedAt = null;
    _tripId = null;
    _driver = null;
    _navigationRoute = null;
    _navigationEtaSeconds = null;
    _driverEtaSeconds = null;
    _driverRemainingMeters = null;
    _driverCancelledNotice = null;
    _requestKey = null;
    _lastRequestPayload = null;
    _requestAckTimer?.cancel();
    _requestAckTimer = null;
    _awaitingServerAck = false;
  }

  Future<void> _requestRideViaRest(
    Map<String, dynamic> payload,
    String key,
  ) async {
    try {
      final response = await ApiService.dio.post('/ride/request', data: payload);
      final data = response.data;
      if (data is Map && _requestKey == key) {
        applyTripUpdate(Trip.fromJson(Map<String, dynamic>.from(data)));
      }
    } on DioException catch (e) {
      if (_requestKey != key) return;
      _requestAckTimer?.cancel();
      _awaitingServerAck = false;
      final serverMsg = e.response?.data is Map
          ? (e.response!.data as Map)['error']?.toString()
          : null;
      final serverCode = e.response?.data is Map
          ? (e.response!.data as Map)['code']?.toString()
          : null;
      if (e.response?.statusCode == 409 && serverCode == 'ACTIVE_RIDE_EXISTS') {
        // A ride is already live for this rider: adopt it instead of
        // surfacing a failure (single-active-ride invariant).
        await hydrateFromServer();
        notifyListeners();
        return;
      }
      if (e.response?.statusCode == 402) {
        // Payment method required — the map screen owns the navigation to
        // the wallet; this is a definitive rejection, not a retry.
        _paymentMethodRequired = true;
        _status = TripStatus.IDLE;
        _requestKey = null;
        _lastRequestPayload = null;
      } else {
        _requestFailure = serverMsg ??
            'We couldn\'t send your ride request. Check your connection and try again.';
      }
      notifyListeners();
    } catch (e) {
      if (_requestKey != key) return;
      _requestAckTimer?.cancel();
      _awaitingServerAck = false;
      _requestFailure =
          'We couldn\'t send your ride request. Check your connection and try again.';
      notifyListeners();
    }
  }

  /// Bounded wait for the authoritative first tripUpdate. On expiry the
  /// outcome is UNKNOWN, so the client RECONCILES via REST with the same
  /// idempotency key instead of assuming failure (a mutation that actually
  /// succeeded resolves to the same ride). Only a failed reconciliation
  /// surfaces the retry state to the rider.
  void _armRequestAckTimer(String key) {
    _requestAckTimer?.cancel();
    _requestAckTimer = Timer(const Duration(seconds: 12), () async {
      if (_requestKey != key) return;
      if (_tripId != null) return; // confirmed by a tripUpdate
      final payload = _lastRequestPayload;
      if (payload == null) return;
      debugPrint('[RIDE] request ack timeout — reconciling via REST (same key)');
      await _requestRideViaRest(payload, key);
    });
  }

  void setEstimatedFare(double fare) {
    _estimatedFare = fare;
    notifyListeners();
  }

  /// Cancels the rider's current request/trip and only resets local state
  /// after the backend confirms. Returns null on success, or a friendly
  /// message when the cancel could not be completed (state is kept intact
  /// so the UI can retry / stay consistent).
  ///
  /// Two paths are used for reliability:
  ///   1. socket `cancelTrip` (fast path when a tripId is already known),
  ///   2. REST `POST /ride/cancel` (idempotent, no tripId needed) — this
  ///      closes the race where the rider hits X before the tripUpdate
  ///      round-trip arrives and the client has no tripId yet.
  Future<String?> cancelRide({String? reasonCode, String? reasonText}) async {
    if (_cancelling) return null;
    _cancelling = true;
    notifyListeners();
    try {
      if (_tripId != null) {
        debugPrint('[RIDE] Cancelling trip $_tripId via socket + REST');
        _socket?.emit('cancelTrip', {
          'tripId': _tripId,
          if (reasonCode != null) 'reasonCode': reasonCode,
          if (reasonText != null) 'reasonText': reasonText,
        });
      }
      final response = await ApiService.dio.post(
        '/ride/cancel',
        data: {
          // Ride-scoped cancel: the backend must never infer a different
          // (possibly in-progress) ride when the client already knows the
          // exact trip it is cancelling.
          if (_tripId != null) 'tripId': _tripId,
          if (reasonCode != null) 'reasonCode': reasonCode,
          if (reasonText != null) 'reasonText': reasonText,
        },
      );
      final data = response.data;
      final cancelled = data is Map && data['cancelled'] == true;
      debugPrint('[RIDE] Cancel REST ok cancelled=$cancelled');
      reset();
      return null;
    } on DioException catch (e) {
      if (e.response?.statusCode == 409) {
        // Only surface "in progress" if the ride we attempted to cancel is
        // GENUINELY still active. Two benign cases resolve to success:
        //   a) the parallel socket emit already cancelled it (authoritative
        //      state is CANCELLED and /ride/current no longer returns it),
        //   b) the trip we knew about is gone and the server evaluated a
        //      different, older ride.
        // Both are probed against the backend instead of guessed locally.
        try {
          final current = await ApiService.dio.get('/ride/current');
          final active = current.data is Map ? current.data['trip'] : null;
          final stillActive =
              active is Map &&
              active['id'] == _tripId &&
              active['status'] != 'CANCELLED';
          if (!stillActive) {
            debugPrint(
              '[RIDE] Cancel 409 but no matching active ride — treating as success',
            );
            reset();
            return null;
          }
        } catch (probeErr) {
          debugPrint('[RIDE] Cancel-409 probe failed: $probeErr');
        }
        if (_status == TripStatus.CANCELLED) {
          debugPrint(
            '[RIDE] Cancel 409 but already CANCELLED via socket — resetting',
          );
          reset();
          return null;
        }
        debugPrint('[RIDE] Cancel refused (409): ride in progress');
        return 'This ride is already in progress and cannot be cancelled.';
      }
      debugPrint(
        '[RIDE] Cancel failed: ${e.response?.statusCode ?? e.type} ${e.message}',
      );
      return 'We couldn\'t cancel the ride right now. Please try again.';
    } catch (e) {
      debugPrint('[RIDE] Cancel failed: $e');
      return 'We couldn\'t cancel the ride right now. Please try again.';
    } finally {
      _cancelling = false;
      notifyListeners();
    }
  }

  void reset() {
    if (_currentTrip != null) _settleTripId(_currentTrip!.id);
    if (_tripId != null) _settleTripId(_tripId!);
    _status = TripStatus.IDLE;
    _tripId = null;
    _currentTrip = null;
    _driver = null;
    _estimatedFare = null;
    _navigationRoute = null;
    _navigationEtaSeconds = null;
    _driverEtaSeconds = null;
    _driverRemainingMeters = null;
    _driverCancelledNotice = null;
    _driverOffline = false;
    _cancelling = false;
    _requestKey = null;
    _lastRequestPayload = null;
    _requestAckTimer?.cancel();
    _requestAckTimer = null;
    _awaitingServerAck = false;
    _currentTripUpdatedAt = null;
    _nearbyDrivers.clear();
    _persistActiveTrip(null);
    notifyListeners();
  }

  /// Cold-start re-attach: a persisted trip id means the app was killed
  /// mid-ride. Restore a provisional non-IDLE state so the tripUpdate
  /// handler accepts the authoritative answer, then let the server reply
  /// (tripUpdate for an active ride, `currentTripNone` → reset if settled).
  Future<void> _restoreActiveTripAfterRestart() async {
    if (_status != TripStatus.IDLE || _tripId != null) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      final stored = prefs.getString(_activeTripKey);
      if (stored == null || stored.isEmpty) return;
      debugPrint('[RIDE] Cold-start restore — re-attaching to trip $stored');
      _status = TripStatus.REQUESTED;
      _tripId = stored;
      notifyListeners();
      _socket?.emit('getCurrentTrip');
    } catch (e) {
      debugPrint('[RIDE] Cold-start restore failed: $e');
    }
  }

  /// Fire-and-forget persistence of the active trip id (or its removal).
  void _persistActiveTrip(String? tripId) {
    SharedPreferences.getInstance()
        .then((prefs) {
          if (tripId == null) {
            prefs.remove(_activeTripKey);
          } else {
            prefs.setString(_activeTripKey, tripId);
          }
        })
        .catchError((e) {
          debugPrint('[RIDE] active_trip_id persistence failed: $e');
        });
  }

  /// REST hydration of the authoritative active ride.
  ///
  /// Recovery must NOT depend on the socket ever connecting: proxies that
  /// block WebSocket upgrades, DNS hiccups or a dead socket would otherwise
  /// leave a rider with a live ride staring at an idle Explore screen. This
  /// is called at cold start, on every foreground, on socket connect, and
  /// when the server reports an existing ride (single-active-ride guard).
  ///
  /// Returns true when an active ride was adopted.
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
        applyTripUpdate(Trip.fromJson(raw), raw, true);
        return true;
      }
      // Authoritative "no active ride": settle any stale local belief.
      if (_status != TripStatus.IDLE && _tripId != null) {
        debugPrint('[RIDE] REST reports no active trip — clearing local state');
        _settleTripId(_tripId!);
        reset();
      }
      return false;
    } catch (e) {
      debugPrint('[RIDE] hydrateFromServer failed (kept local state): $e');
      return false;
    }
  }

  /// Replays the cached navigation leg after a cold start. The rider map is
  /// driven by server-pushed routes (`navigationStarted` etc.) which are
  /// never replayed on reconnect, so fetch the authoritative cached leg over
  /// REST (party-scoped on the backend) instead of re-planning it locally.
  Future<void> _replayNavigationRoute(Trip trip) async {
    final leg = trip.status == TripStatus.IN_PROGRESS ? 'destination' : 'pickup';
    try {
      final response = await ApiService.dio.get(
        '/navigation/cached',
        queryParameters: {'tripId': trip.id, 'leg': leg},
      );
      final data = response.data;
      final route = data is Map ? data['route'] : null;
      if (route is Map) {
        _setNavigationRoute({
          'tripId': trip.id,
          'route': Map<String, dynamic>.from(route),
        });
      }
    } catch (e) {
      debugPrint('[RIDE] Navigation replay failed (non-fatal): $e');
    }
  }

  /// Driver-connectivity state pushed by the backend watchdog. Exposed for
  /// tests so the exact trip-scoping rule is asserted on the real path.
  @visibleForTesting
  void applyDriverConnectivity(Map<String, dynamic> data) {
    final eventTripId = data['tripId']?.toString();
    if (eventTripId != null &&
        eventTripId.isNotEmpty &&
        _tripId != null &&
        eventTripId != _tripId) {
      return;
    }
    final connected = data['connected'] == true;
    if (_driverOffline == !connected) return;
    _driverOffline = !connected;
    debugPrint(
      '[RIDE] Driver connectivity changed → ${connected ? 'online' : 'offline'}',
    );
    notifyListeners();
  }

  void updateLocation(double lat, double lng) {
    _lastKnownLocation = Location(lat: lat, lng: lng);
    _socket?.emit('updateLocation', {'lat': lat, 'lng': lng});
  }

  /// Report rider activity to the demand heatmap pipeline. The gateway
  /// also records APP_OPEN (on subscribeToNearbyDrivers) and RIDE_REQUESTED
  /// (on requestRide) itself; this covers the rest:
  ///   - REQUEST_FLOW: rider is actively planning a ride (destination pick)
  ///   - APP_ACTIVE:   rider is using the app right now (on foreground)
  /// Coordinates are optional for APP_ACTIVE (the server can re-use the
  /// rider's last known position).
  void reportActivity(String type, {double? lat, double? lng}) {
    final useLat = lat ?? _lastKnownLocation?.lat;
    final useLng = lng ?? _lastKnownLocation?.lng;
    if (useLat == null || useLng == null) {
      debugPrint('[RIDE] reportActivity($type) skipped — no location yet');
      return;
    }
    debugPrint('[RIDE] reportActivity($type) @ $useLat,$useLng');
    _socket?.emit('reportActivity', {
      'type': type,
      'lat': useLat,
      'lng': useLng,
    });
  }

  /// Parse the route payload shipped with navigationStarted /
  /// navigationRerouteRequested and make it the authoritative route for
  /// the trip screen. Handles every shape the backend emits:
  ///   - `polyline`:        [[lng, lat], ...]
  ///   - `points_list`:     [[lng, lat], ...]
  ///   - `geometry`:        GeoJSON LineString coordinates
  ///   - `encodedPolyline`: polyline6 string
  void _setNavigationRoute(dynamic data) {
    if (data is! Map) return;
    if (data['tripId'] != null && data['tripId'] != _tripId) return;

    final route = data['route'];
    if (route is! Map) return;
    final routeMap = Map<String, dynamic>.from(route);

    final points = _decodeRoutePoints(routeMap);
    if (points.isEmpty) return;

    _navigationRoute = points;
    final eta = (routeMap['eta'] as num?)?.toDouble() ?? 0;
    final duration = (routeMap['duration'] as num?)?.toDouble() ?? 0;
    final traffic = (routeMap['trafficDurationSeconds'] as num?)?.toDouble();
    _navigationEtaSeconds = (traffic ?? (eta > 0 ? eta : duration)).toDouble();
    _navigationCacheHit =
        routeMap['cache_hit'] == true || routeMap['cacheHit'] == true;
    notifyListeners();
  }

  List<LatLng> _decodeRoutePoints(Map<String, dynamic> route) {
    final raw = route['points_list'] ?? route['polyline'];
    if (raw is List && raw.isNotEmpty) {
      final first = raw.first;
      if (first is LatLng) {
        return raw.whereType<LatLng>().toList();
      }
      final out = <LatLng>[];
      for (final c in raw) {
        if (c is List && c.length >= 2 && c[0] is num && c[1] is num) {
          out.add(LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble()));
        }
      }
      if (out.isNotEmpty) return out;
    }

    final geometry = route['geometry'];
    if (geometry is Map && geometry['type'] == 'LineString') {
      final coords = geometry['coordinates'] as List? ?? [];
      final out = <LatLng>[];
      for (final c in coords) {
        if (c is List && c.length >= 2 && c[0] is num && c[1] is num) {
          out.add(LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble()));
        }
      }
      if (out.isNotEmpty) return out;
    }

    final encoded = route['encodedPolyline'];
    if (encoded is String && encoded.isNotEmpty) {
      return _decodePolyline6(encoded);
    }

    return const [];
  }

  /// Google polyline6 decoder -> List<LatLng>.
  List<LatLng> _decodePolyline6(String encoded) {
    final points = <LatLng>[];
    int index = 0;
    final len = encoded.length;
    int lat = 0;
    int lng = 0;
    while (index < len) {
      int b;
      int shift = 0;
      int result = 0;
      do {
        b = encoded.codeUnitAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      final dlat = (result & 1) != 0 ? ~(result >> 1) : result >> 1;
      lat += dlat;
      shift = 0;
      result = 0;
      do {
        b = encoded.codeUnitAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      final dlng = (result & 1) != 0 ? ~(result >> 1) : result >> 1;
      lng += dlng;
      points.add(LatLng(lat / 1e5, lng / 1e5));
    }
    return points;
  }

  Future<void> rateRide(
    String rideId,
    int rating,
    String reviewText, {
    bool favorite = false,
  }) async {
    await ApiService.rateRide(
      rideId: rideId,
      rating: rating,
      reviewText: reviewText,
      favorite: favorite,
    );
  }

  Future<void> submitTip(String rideId, double amount) async {
    await ApiService.dio.post('/ride/$rideId/tip', data: {'amount': amount});
  }

  Future<void> onAppForegrounded() async {
    if (_socket == null || !_socket!.connected) {
      debugPrint('[RIDE] Socket disconnected on foreground — reinitializing');
      final token = SecureTokenStore.token;
      if (token != null) {
        initSocket(token);
      }
    } else if (_status != TripStatus.IDLE) {
      // Live socket: still re-ask for the authoritative trip. A match or
      // terminal transition may have happened while the process was
      // suspended and the socket silently missed the event.
      debugPrint('[RIDE] Foreground resync for status=$_status');
      _socket!.emit('getCurrentTrip');
    }
    // REST resync on EVERY foreground: recovery must not depend on the
    // socket connecting (blocked ws, doze, proxy, DNS).
    await hydrateFromServer();
    // Signal "rider actively using the app" with their last known position
    // (privacy-safe: backendside cooldowns cap the rate).
    reportActivity('APP_ACTIVE');
  }

  @override
  void dispose() {
    _socket?.disconnect();
    _notificationPing.close();
    super.dispose();
  }
}