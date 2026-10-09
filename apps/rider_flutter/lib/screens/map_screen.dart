import 'dart:async';
import 'dart:math' as math;
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:geolocator/geolocator.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../providers/ride_provider.dart';
import '../services/ride_intent.dart';
import '../providers/specials_provider.dart';
import '../models/special_models.dart';
import '../models/trip_models.dart' as models;
import '../services/routing_service.dart';
import '../services/user_service.dart';
import '../services/auth_service.dart';
import '../services/route_cache_service.dart';
import '../services/eta_cache_service.dart';
import '../services/search_history_service.dart';
import '../models/search_result.dart';
import '../models/reward_models.dart';
import '../services/rewards_service.dart';
import '../services/payments_service.dart';
import 'address_search_delegate.dart';
import '../components/state_container.dart';
import '../components/smooth_driver_marker.dart';
import '../components/animated_price.dart';
import '../components/driver_cancelled_dialog.dart';
import '../widgets/branded_map_tile.dart';
import '../widgets/explore_specials_section.dart';
import '../widgets/explore_validation_section.dart';
import '../widgets/special_business_sheet.dart';
import '../widgets/special_card.dart';
import 'wallet_screen.dart';

class MapScreen extends StatefulWidget {
  const MapScreen({super.key});

  @override
  State<MapScreen> createState() => _MapScreenState();
}

class _MapScreenState extends State<MapScreen>
    with TickerProviderStateMixin, WidgetsBindingObserver {
  final MapController _mapController = MapController();
  final RoutingService _routingService = RoutingService();
  LatLng? _userPosition;
  LatLng? _smoothedPosition;
  models.Location? _pickup;
  models.Location? _destination;
  List<LatLng> _routePoints = [];
  Timer? _geohashTimer;
  ViewState _state = ViewState.loading;
  String? _errorMessage;
  bool _isMapReady = false;
  bool _shouldFollowUser = true;
  StreamSubscription<Position>? _positionSubscription;
  String _firstName = "";

  // Ride-selection panel state (kept on the map, never navigates away).
  bool _panelOpen = false;
  bool _loadingEstimates = false;
  bool _requesting = false;
  double _estimateFare = 0.0;
  double _estimateDurationSeconds = 0.0;
  bool _hasNavigatedToTrip = false;

  /// Notice id that already got its pre-pickup driver-cancel apology
  /// dialog. One dialog per driver cancellation (a fresh notice id pops it
  /// again), while a repeated rebuild must not.
  int? _driverCancelNotifiedNoticeId;

  /// Trip id this map instance resumed searching for after a driver
  /// cancellation (or cold-start re-attach). Set when the existing search
  /// sheet auto-opens for an already-searchable ride; guards re-entry and
  /// drives cancellation/close cleanup without a local "request" flag.
  String? _resumedSearchTripId;

  // Rewards options at checkout (promo code + ride credits + payment).
  final TextEditingController _promoCodeController = TextEditingController();
  bool _applyCredits = false;
  int? _creditBalanceCents;
  bool _creditBalanceLoaded = false;
  PromoPreview? _promoPreview;
  bool _promoChecking = false;
  bool _promoApplied = false;

  // Part 3 — credits amount selector. The rider can apply a validated
  // manual amount instead of the whole balance; the backend caps the debit
  // at min(balance, remaining fare, requested) so the server stays truth.
  int? _creditUseCents;
  final TextEditingController _customCreditController = TextEditingController();
  String? _creditAmountError;

  // Part 6 — Favorite Driver toggle state
  bool _favoriteDriverEnabled = false;
  // EXPLICIT consent for the Special no-show fallback: if the sponsor code
  // is not validated before the deadline, NetRide collects the remaining
  // fare. Server-enforced — the backend refuses the special ride without it.
  bool _specialTermsAccepted = false;

  // Part — SPECIALS: an active (CREATED / RIDE_PENDING) special redemption
  // discovered by the rider. Sent with the ride request so the backend
  // applies the sponsor discount inside the pricing transaction.
  String? _specialRedemptionId;

  // Zero-balance feedback: tapping the disabled Ride Credits toggle shakes
  // the row and flashes a red "no credits" hint (pulse).
  late final AnimationController _creditsShakeController;
  bool _creditsZeroFeedback = false;
  Timer? _creditsZeroTimer;

  // Part 2 — map expansion states:
  //   A. mini map (explore mode, gestures off, tap to expand)
  //   B. full-screen map (back arrow top-left, gestures on)
  //   C. destination set -> auto-expand + fit camera to the route
  bool _mapExpanded = false;
  Timer? _cameraFitTimer;

  // Raw-pointer tap detection for the mini map: flutter_map always keeps a
  // TapGestureRecognizer in the arena, which would steal taps from a plain
  // GestureDetector — a Listener bypasses the arena entirely.
  Offset? _miniTapDownPosition;
  DateTime? _miniTapDownAt;

  // Part 3 — draggable ride-selection bottom sheet (0 = collapsed pill,
  // 1 = fully expanded). Fraction is driven by a single AnimationController
  // so drags and snap animations share one value source.
  late final AnimationController _sheetController;
  double _dragStartFraction = 0.0;
  static const double _sheetMinHeight = 96;
  static const double _sheetMaxFraction = 0.62;

  // Smooth camera pan used when a Special is selected (spec §14/§28).
  late final AnimationController _cameraMoveController;
  LatLng? _cameraMoveFrom;
  LatLng? _cameraMoveTo;
  double _cameraMoveFromZoom = 15;
  double _cameraMoveToZoom = 15;

  // Explore: recent searches shown under the destination card. The backend
  // search-history store is the single source of truth (same one the
  // address-search delegate reads inside the search screen).
  List<SearchResult> _recentSearches = [];

  /// Periodic active-special refreshes while Explore is the visible tab
  /// (TickerMode is disabled by the IndexedStack for hidden tabs). The
  /// backend has no realtime sponsor-status stream, so a short-interval
  /// refresh is what makes an admin deactivation disappear from an already
  /// OPEN Explore screen without permanent stale cards. 3 minutes keeps it
  /// far below "excessive polling" and only ONE endpoint behind the scene.
  Timer? _specialsRefreshTimer;

  /// Selected-special synchronization (spec §14/§15/§30): the provider is
  /// the single source of truth. When a Special is selected (from a card or
  /// a map marker) the explore map expands and smoothly centers on it; the
  /// red selected marker styling is derived from the same id.
  late final SpecialsProvider _specialsProvider;
  String? _lastSelectedSpecialId;

  void _onSpecialSelectionChanged() {
    final id = _specialsProvider.selectedSpecialId;
    if (id == _lastSelectedSpecialId) return;
    _lastSelectedSpecialId = id;
    if (id == null) return;
    SponsorSpecial? sponsor;
    for (final s in _specialsProvider.sponsors) {
      if (s.id == id) {
        sponsor = s;
        break;
      }
    }
    final lat = sponsor?.latitude;
    final lng = sponsor?.longitude;
    if (lat == null || lng == null) return;
    _expandMap();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_isMapReady) return;
      try {
        final zoom = math.max(_mapController.camera.zoom, 15.0);
        _animateMapTo(LatLng(lat, lng), zoom);
        setState(() => _shouldFollowUser = false);
      } catch (e) {
        debugPrint('[EXPLORE] focus special failed: $e');
      }
    });
  }

  /// Eases the camera to [target] instead of jumping (spec §28).
  void _animateMapTo(LatLng target, double zoom) {
    try {
      _cameraMoveFrom = _mapController.camera.center;
      _cameraMoveFromZoom = _mapController.camera.zoom;
    } catch (_) {
      _cameraMoveFrom = null;
    }
    _cameraMoveTo = target;
    _cameraMoveToZoom = zoom;
    _cameraMoveController.forward(from: 0);
  }

  void _tickCameraMove() {
    final from = _cameraMoveFrom;
    final to = _cameraMoveTo;
    if (from == null || to == null || !_isMapReady) return;
    final t = Curves.easeOutCubic.transform(_cameraMoveController.value);
    final lat = from.latitude + (to.latitude - from.latitude) * t;
    final lng = from.longitude + (to.longitude - from.longitude) * t;
    final zoom = _cameraMoveFromZoom + (_cameraMoveToZoom - _cameraMoveFromZoom) * t;
    try {
      _mapController.move(LatLng(lat, lng), zoom);
    } catch (_) {
      // Map detached mid-animation — nothing to do.
    }
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _specialsProvider = context.read<SpecialsProvider>();
    _specialsProvider.addListener(_onSpecialSelectionChanged);
    // Server booking gate: when the backend refuses a request because no
    // payment card is saved, navigate the rider to the Payment Method page.
    context.read<RideProvider>().addListener(_onRideProviderChanged);
    _specialsRefreshTimer = Timer.periodic(const Duration(minutes: 3), (_) {
      if (!mounted || !TickerMode.of(context)) return;
      context.read<SpecialsProvider>().refresh(
        lat: _smoothedPosition?.latitude,
        lng: _smoothedPosition?.longitude,
      );
    });
    _sheetController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 300),
    );
    _cameraMoveController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 380),
    )..addListener(_tickCameraMove);
    _creditsShakeController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 420),
    );
    RideIntent.instance.notifier.addListener(_onRideIntent);
    _initCacheServices();
    _initLiveLocation();
    _fetchProfile();
    _startGeohashUpdates();
    _loadRecentSearches();
    _loadRewardsOptions();
    // Explore asks the backend for the currently active specials the moment
    // it opens — the section and the sponsor markers render from that
    // response, so a zero-active specials backend shows ZERO SPECIALS UI.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final specials = context.read<SpecialsProvider>();
      if (!specials.loaded) specials.refresh();
    });
  }

  Future<void> _loadRecentSearches() async {
    final recent = await SearchHistoryService.instance.fetch();
    if (!mounted) return;
    final results = recent.take(6).toList();
    if (_userPosition != null) {
      for (final result in results) {
        result.recalculateFrom(
          _userPosition!.latitude,
          _userPosition!.longitude,
        );
      }
    }
    setState(() => _recentSearches = results);
  }

  /// Tapping a recent search sets it straight as the destination (same
  /// source of truth, no duplicated repository).
  Future<void> _applyRecentSearch(SearchResult result) async {
    setState(() {
      _destination = models.Location(
        lat: result.lat,
        lng: result.lon,
        address: result.displayName,
      );
      _shouldFollowUser = false;
    });
    _updateRoute();
  }

  /// A special's "Book a ride to this place" handed us a destination: pre-fill
  /// it, attach the active redemption, and start the NORMAL ride planning
  /// flow (route + ride options + confirm → searching).
  void _onRideIntent() {
    final intent = RideIntent.instance.notifier.value;
    if (intent == null || !mounted) return;
    RideIntent.instance.clear();

    final specials = context.read<SpecialsProvider>();
    _specialRedemptionId = specials.canAttachToRide
        ? specials.current!.id
        : null;

    final userPos = _userPosition;
    setState(() {
      _pickup = models.Location(
        lat: userPos?.latitude ?? intent.lat,
        lng: userPos?.longitude ?? intent.lng,
        address: 'Current Location',
      );
      _destination = models.Location(
        lat: intent.lat,
        lng: intent.lng,
        address: intent.address,
      );
      _shouldFollowUser = false;
    });
    _updateRoute();
    // Demand signal for the heatmap (same as a manual destination pick).
    context.read<RideProvider>().reportActivity(
      'REQUEST_FLOW',
      lat: intent.lat,
      lng: intent.lng,
    );
  }

  Future<void> _initCacheServices() async {
    final prefs = await SharedPreferences.getInstance();
    await RouteCacheService.instance.init(prefs);
    await EtaCacheService.instance.init(prefs);
  }

  void _startGeohashUpdates() {
    _geohashTimer?.cancel();
    _geohashTimer = Timer.periodic(const Duration(seconds: 15), (timer) {
      if (_userPosition != null) {
        Provider.of<RideProvider>(
          context,
          listen: false,
        ).subscribeToNearbyDrivers(
          models.Location(
            lat: _userPosition!.latitude,
            lng: _userPosition!.longitude,
          ),
        );
      }
    });
  }

  Future<void> _fetchProfile() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (!prefs.containsKey('jwt_token')) return;

      final profile = await UserService.getProfile();
      if (mounted) {
        setState(() {
          final fullName = profile['full_name'] ?? 'User';
          _firstName = fullName.split(' ')[0];
        });
      }
    } catch (e) {
      if (e is DioException && e.response?.statusCode == 404) {
        debugPrint('User not found (404), logging out...');
        await AuthService.logout();
        if (mounted) {
          Navigator.pushNamedAndRemoveUntil(
            context,
            '/login',
            (route) => false,
          );
        }
        return;
      }
      debugPrint('Error fetching profile: $e');
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Admin deactivation while the app is backgrounded must reach Explore:
    // re-query the authoritative active-special list on every foreground.
    if (state == AppLifecycleState.resumed && mounted) {
      context.read<SpecialsProvider>().refresh(
        lat: _smoothedPosition?.latitude,
        lng: _smoothedPosition?.longitude,
      );
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    RideIntent.instance.notifier.removeListener(_onRideIntent);
    context.read<RideProvider>().removeListener(_onRideProviderChanged);
    _specialsProvider.removeListener(_onSpecialSelectionChanged);
    _specialsRefreshTimer?.cancel();
    _positionSubscription?.cancel();
    _geohashTimer?.cancel();
    _cameraFitTimer?.cancel();
    _creditsZeroTimer?.cancel();
    _sheetController.dispose();
    _cameraMoveController.dispose();
    _creditsShakeController.dispose();
    _promoCodeController.dispose();
    _customCreditController.dispose();
    super.dispose();
  }

  Future<void> _initLiveLocation() async {
    setState(() => _state = ViewState.loading);
    try {
      bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!mounted) return;
      if (!serviceEnabled) {
        setState(() {
          _state = ViewState.failure;
          _errorMessage =
              'Location services are disabled. Please enable them in your settings.';
        });
        return;
      }

      LocationPermission permission = await Geolocator.checkPermission();
      if (!mounted) return;
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
        if (!mounted) return;
        if (permission == LocationPermission.denied) {
          setState(() {
            _state = ViewState.failure;
            _errorMessage = 'Location permissions are required to use NetRide.';
          });
          return;
        }
      }

      if (permission == LocationPermission.deniedForever) {
        if (!mounted) return;
        setState(() {
          _state = ViewState.failure;
          _errorMessage =
              'Location permissions are permanently denied. Please enable them in system settings.';
        });
        return;
      }

      final position = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.bestForNavigation,
      );
      if (!mounted) return;

      _userPosition = LatLng(position.latitude, position.longitude);
      _smoothedPosition = _userPosition;
      _updateUserLocation(position);
      // Once we know where the rider is, re-query the active specials from
      // the backend distance-ordered (cards show real distances, markers use
      // the same eligible list).
      context.read<SpecialsProvider>().refresh(
        lat: position.latitude,
        lng: position.longitude,
      );

      _positionSubscription =
          Geolocator.getPositionStream(
            locationSettings: const LocationSettings(
              accuracy: LocationAccuracy.bestForNavigation,
              distanceFilter: 0,
            ),
          ).listen((position) {
            _updateUserLocation(position);
          });

      if (!mounted) return;
      setState(() => _state = ViewState.success);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _state = ViewState.failure;
        _errorMessage =
            'An error occurred while initializing location tracking.';
      });
    }
  }

  void _updateUserLocation(Position position) {
    if (!mounted) return;

    final newPos = LatLng(position.latitude, position.longitude);

    setState(() {
      _userPosition = newPos;
      _smoothedPosition = newPos; // For simplicity now
      _pickup ??= models.Location(
        lat: position.latitude,
        lng: position.longitude,
        address: 'Current Location',
      );
    });

    // Refresh distances for recent places when location changes
    if (_recentSearches.isNotEmpty && _userPosition != null) {
      for (final result in _recentSearches) {
        result.recalculateFrom(
          _userPosition!.latitude,
          _userPosition!.longitude,
        );
      }
    }

    if (_shouldFollowUser && _smoothedPosition != null && _isMapReady) {
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        if (mounted && _isMapReady) {
          try {
            _mapController.move(_smoothedPosition!, 15.0);
          } catch (e) {
            debugPrint('Map move error: $e');
          }
        }
      });
    }
  }

  Future<void> _openSearch(bool isPickup) async {
    final result = await showSearch<SearchResult?>(
      context: context,
      delegate: AddressSearchDelegate(
        userLat: _userPosition?.latitude,
        userLon: _userPosition?.longitude,
        searchFieldLabel: isPickup
            ? 'Enter pickup location'
            : 'Enter destination',
      ),
    );

    if (result != null && mounted) {
      setState(() {
        final loc = models.Location(
          lat: result.lat,
          lng: result.lon,
          address: result.displayName,
        );
        if (isPickup) {
          _pickup = loc;
        } else {
          _destination = loc;
          _shouldFollowUser = false;
          // The rider is actively planning a ride → demand signal for the
          // heatmap (server-side cooldowns dedupe bursts).
          context.read<RideProvider>().reportActivity(
            'REQUEST_FLOW',
            lat: loc.lat,
            lng: loc.lng,
          );
        }
      });
      _updateRoute();
      // The search screen saved this pick; keep Explore's recent list fresh.
      _loadRecentSearches();
    }
  }

  /// Reverts a custom pickup point back to the live GPS position. The
  /// "Use Current Location" restore affordance calls this.
  Future<void> _restoreCurrentLocation() async {
    if (_userPosition == null || _pickup == null) return;
    if (_pickup!.address == 'Current Location') return;

    setState(() {
      _pickup = models.Location(
        lat: _userPosition!.latitude,
        lng: _userPosition!.longitude,
        address: 'Current Location',
      );
    });
    // The GPS marker becomes the pickup again; refit the route to the
    // live position (the destination, if any, is untouched).
    if (_destination != null) {
      _updateRoute();
    } else {
      setState(() => _routePoints = []);
      _mapController.move(_userPosition!, 15.0);
    }
  }

  void _updateRoute() async {
    if (_pickup == null || _destination == null) return;

    final wasExpanded = _mapExpanded;

    try {
      final plan = await _routingService.plan(
        origin: LatLng(_pickup!.lat, _pickup!.lng),
        destination: LatLng(_destination!.lat, _destination!.lng),
      );

      if (mounted) {
        setState(() {
          _routePoints = plan.points;
        });

        if (!wasExpanded) {
          // Part 2 state C: destination chosen from the mini map — expand
          // to full screen first, then fit the camera once the size
          // animation has settled so the bounds math sees the final viewport.
          setState(() => _mapExpanded = true);
          _cameraFitTimer?.cancel();
          _cameraFitTimer = Timer(const Duration(milliseconds: 520), () {
            if (mounted) _fitRouteCamera();
          });
        } else {
          _fitRouteCamera();
        }
      }

      // Save route to history for caching (async, don't block UI)
      _saveRouteToHistory(plan);
    } catch (e) {
      debugPrint('Route error: $e');
    }

    // Once both endpoints exist, open the in-map ride-selection panel and
    // fetch the ride options for every class in a single batch call.
    if (_pickup != null && _destination != null && !_panelOpen) {
      _openRidePanel();
    }
  }

  /// Fits the camera to the pickup -> destination corridor (with margin).
  void _fitRouteCamera() {
    if (!mounted) return;
    if (_routePoints.isEmpty || _pickup == null || _destination == null) return;
    try {
      final bounds = LatLngBounds.fromPoints([
        LatLng(_pickup!.lat, _pickup!.lng),
        LatLng(_destination!.lat, _destination!.lng),
        ..._routePoints,
      ]);
      _mapController.fitCamera(
        CameraFit.bounds(bounds: bounds, padding: const EdgeInsets.all(56)),
      );
    } catch (e) {
      debugPrint('fitCamera error: $e');
    }
  }

  /// Part 2 state A -> B: tap on the mini map expands it to full screen.
  void _expandMap() {
    if (_mapExpanded || _state != ViewState.success) return;
    setState(() => _mapExpanded = true);
  }

  /// Part 2 state B/C -> A: back arrow returns to the mini map. The
  /// destination and the open bottom sheet are preserved.
  void _collapseMap() {
    if (!_mapExpanded) return;
    _cameraFitTimer?.cancel();
    setState(() => _mapExpanded = false);
  }

  Future<void> _saveRouteToHistory(TripPlan plan) async {
    try {
      if (_pickup == null || _destination == null) return;

      final route = CachedRoute(
        originLat: _pickup!.lat,
        originLon: _pickup!.lng,
        destLat: _destination!.lat,
        destLon: _destination!.lng,
        originName: _pickup!.address ?? 'Current Location',
        destName: _destination!.address ?? 'Destination',
        distanceMeters: plan.distanceMeters,
        durationSeconds: plan.durationSeconds,
        trafficDurationSeconds: plan.trafficDurationSeconds,
        polyline: plan.points,
        vehicleClass: 'CORE',
        savedAt: DateTime.now(),
      );
      await SearchHistoryService.instance.saveRoute(route);
    } catch (e) {
      debugPrint('Save route history error: $e');
    }
  }

  Future<void> _openRidePanel() async {
    setState(() {
      _panelOpen = true;
      _loadingEstimates = true;
      _estimateFare = 0.0;
    });
    await _fetchEstimate();
  }

  /// Pulls the ride estimate (route geometry + platform fare).
  /// Checks the ETA cache first; makes ONE backend call for route data.
  /// Writes to cache on success. The fare is always the backend-computed
  /// value — never derived client-side.
  Future<void> _fetchEstimate() async {
    if (_pickup == null || _destination == null) return;
    setState(() => _loadingEstimates = true);

    final originLat = _pickup!.lat;
    final originLng = _pickup!.lng;
    final destLat = _destination!.lat;
    final destLng = _destination!.lng;

    final cachedEta = EtaCacheService.instance.get(
      originLat: originLat,
      originLng: originLng,
      destLat: destLat,
      destLng: destLng,
    );

    if (cachedEta != null) {
      // Serve the route metrics (distance/duration) instantly from cache —
      // but NEVER a cached price. Fares are backend-authoritative and change
      // whenever the admin edits pricing, so every cache hit re-fetches the
      // fare from the backend and shows "Calculating…" until it lands.
      _buildEstimateFromRouteData(
        distanceMeters: cachedEta.distanceMeters,
        durationSeconds: cachedEta.durationSeconds,
        backendFareTotal: 0.0,
        engine: 'EtaCache',
      );
      _refreshEstimateInBackground(
        originLat: originLat,
        originLng: originLng,
        destLat: destLat,
        destLng: destLng,
      );
      return;
    }

    try {
      final plan = await _routingService.plan(
        origin: LatLng(originLat, originLng),
        destination: LatLng(destLat, destLng),
      );

      EtaCacheService.instance.set(
        originLat: originLat,
        originLng: originLng,
        destLat: destLat,
        destLng: destLng,
        distanceMeters: plan.distanceMeters,
        durationSeconds: plan.durationSeconds,
        trafficDurationSeconds: plan.trafficDurationSeconds,
      );

      _buildEstimateFromRouteData(
        distanceMeters: plan.distanceMeters,
        durationSeconds: plan.durationSeconds,
        backendFareTotal: (plan.fare['totalFare'] as num?)?.toDouble() ?? 0.0,
        engine: plan.engine,
      );

      if (mounted) {
        setState(() {
          _routePoints = plan.points;
          _loadingEstimates = false;
        });
      }
    } catch (e) {
      if (e is DioException && e.type == DioExceptionType.cancel) return;
      debugPrint('Estimate error: $e');
      if (mounted) {
        setState(() => _loadingEstimates = false);
      }
    }
  }

  /// Background refetch (bypasses both caches) for a fare-less cached ETA.
  /// The UI keeps serving the cached values; when the fresh, backend-priced
  /// plan lands, the estimate updates live and the cache entry is healed
  /// with the fare. Non-fatal on network failure — the old entry stays.
  Future<void> _refreshEstimateInBackground({
    required double originLat,
    required double originLng,
    required double destLat,
    required double destLng,
  }) async {
    try {
      final plan = await _routingService.plan(
        origin: LatLng(originLat, originLng),
        destination: LatLng(destLat, destLng),
        bypassCache: true,
      );
      final fareTotal = (plan.fare['totalFare'] as num?)?.toDouble();
      if (!mounted) return;
      _buildEstimateFromRouteData(
        distanceMeters: plan.distanceMeters,
        durationSeconds: plan.durationSeconds,
        backendFareTotal: fareTotal ?? 0.0,
        engine: 'BackgroundRefresh',
      );
      EtaCacheService.instance.set(
        originLat: originLat,
        originLng: originLng,
        destLat: destLat,
        destLng: destLng,
        distanceMeters: plan.distanceMeters,
        durationSeconds: plan.durationSeconds,
        trafficDurationSeconds: plan.trafficDurationSeconds,
      );
      setState(() {
        _loadingEstimates = false;
        if (plan.points.isNotEmpty) _routePoints = plan.points;
      });
      debugPrint(
        '[ESTIMATE] Background fare refresh landed: ${fareTotal ?? 'no fare'}',
      );
    } catch (e) {
      debugPrint('[ESTIMATE] Background fare refresh failed (kept cache): $e');
      if (mounted) setState(() => _loadingEstimates = false);
    }
  }

  void _buildEstimateFromRouteData({
    required double distanceMeters,
    required double durationSeconds,
    double backendFareTotal = 0.0,
    required String engine,
  }) {
    _estimateDurationSeconds = durationSeconds;
    // Backend total when available; otherwise no price is shown (the
    // backend is the only place fares are computed).
    _estimateFare = backendFareTotal > 0 ? backendFareTotal : 0.0;
  }

  // ---------------------------------------------------------------------
  // Part 3 — checkout math. Server truth on charge; these are display-only
  // hints that mirror what the backend will debit.
  // ---------------------------------------------------------------------

  int get _fareCents => (_estimateFare * 100).round();

  int get _promoDiscountCents =>
      _promoApplied ? (_promoPreview?.discountCents ?? 0) : 0;

  /// Credits that will actually be applied: min(balance, requested,
  /// remaining fare after promo). Mirrors the backend cap.
  int get _creditsToUseCents {
    if (!_applyCredits) return 0;
    final balance = math.max(0, _creditBalanceCents ?? 0);
    final afterPromo = math.max(0, _fareCents - _promoDiscountCents);
    final requested = math.max(0, _creditUseCents ?? 0);
    if (requested == 0) return 0;
    return math.min(balance, math.min(afterPromo, requested));
  }

  /// What the rider owes: fare − promo − credits.
  int get _finalCents =>
      math.max(0, _fareCents - _promoDiscountCents - _creditsToUseCents);

  int get _totalSavedCents => _promoDiscountCents + _creditsToUseCents;

  /// A special (sponsor deal) is attached to this ride: the redemption was
  /// created from the business bottom sheet and this map attaches it to the
  /// request, so the backend applies the sponsor discount. Promo codes are
  /// disabled for special rides.
  bool get _specialAttached => _specialRedemptionId != null;

  void _onRideProviderChanged() {
    final ride = context.read<RideProvider>();
    if (ride.paymentMethodRequired) {
      ride.consumePaymentMethodRequired();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Add a payment card before requesting a ride. Your rides will '
              'be charged to the card on file.',
            ),
          ),
        );
        _openWalletScreen();
      });
    }
  }

  Future<void> _confirmRide() async {
    if (_pickup == null || _destination == null) return;
    // SPECIALS: attach the rider's CREATED redemption (if any) so the
    // backend applies the sponsor discount inside the pricing transaction.
    final specials = Provider.of<SpecialsProvider>(context, listen: false);
    _specialRedemptionId = specials.canAttachToRide
        ? specials.current!.id
        : null;
    if (_specialRedemptionId != null && !_specialTermsAccepted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Please accept the Special terms: if the sponsor code is not '
            'validated before the deadline, the remaining fare may be charged.',
          ),
        ),
      );
      return;
    }
    // Booking gate preflight: a saved card is required to request rides (the
    // server enforces this too — this only improves the UX). Direct the
    // rider to the Payment Method page instead of failing silently.
    if (_specialRedemptionId == null) {
      try {
        final profile = await PaymentsService.getProfile();
        if (profile.configured && !profile.hasCard) {
          if (!mounted) return;
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text(
                'Add a payment card before requesting a ride. Your rides will '
                'be charged to the card on file.',
              ),
            ),
          );
          _openWalletScreen();
          return;
        }
      } catch (_) {
        // Stripe unconfigured or offline — the server remains authoritative.
      }
    }
    setState(() => _requesting = true);
    Provider.of<RideProvider>(context, listen: false).requestRide(
      _pickup!,
      _destination!,
      favoritePriority: _favoriteDriverEnabled,
      promoCode: _promoApplied && !_specialAttached
          ? _promoCodeController.text
          : null,
      applyCredits: _creditsToUseCents > 0,
      creditUseCents: _creditsToUseCents > 0 ? _creditsToUseCents : null,
      specialRedemptionId: _specialRedemptionId,
      specialTermsAccepted: _specialTermsAccepted,
    );
  }

  Future<void> _closePanel({bool cancelIfRequesting = true}) async {
    final rideProvider = Provider.of<RideProvider>(context, listen: false);
    // Any open "searching" sheet — initial request OR a resumed search
    // after a driver cancellation — cancels the pending ride on close,
    // exactly like the sheet's own Cancel Ride button.
    final hasActiveSearch = _requesting || rideProvider.isSearchingForDriver;
    if (cancelIfRequesting && hasActiveSearch) {
      final error = await rideProvider.cancelRide();
      if (!mounted) return;
      if (error != null) {
        // Keep the sheet open so the rider can retry; surface why.
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error)));
        setState(() => _requesting = false);
        _animateSheetTo(1);
        return;
      }
    }
    if (!mounted) return;
    _cameraFitTimer?.cancel();
    setState(() {
      _panelOpen = false;
      _requesting = false;
      _resumedSearchTripId = null;
      _mapExpanded = false;
      _destination = null;
      _routePoints = [];
      _shouldFollowUser = true;
      _hasNavigatedToTrip = false;
      _promoCodeController.clear();
      _promoPreview = null;
      _promoApplied = false;
      _specialRedemptionId = null;
      _applyCredits = false;
      _creditUseCents = null;
      _creditAmountError = null;
      _creditsZeroFeedback = false;
      _customCreditController.clear();
      _favoriteDriverEnabled = false;
    });
    _animateSheetTo(0);
  }

  /// Cancel Ride button (searching state): confirm, then cancel via the
  /// provider; only close the sheet once the backend confirms.
  Future<void> _requestCancel() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: const Text(
          'Cancel Ride?',
          style: TextStyle(fontWeight: FontWeight.w700),
        ),
        content: const Text(
          'Are you sure you want to cancel this ride request?',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('No, Keep'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text(
              'Yes, Cancel',
              style: TextStyle(color: Color(0xFFC65A5A)),
            ),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    final error = await Provider.of<RideProvider>(
      context,
      listen: false,
    ).cancelRide();
    if (!mounted) return;
    if (error != null) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(error)));
      return;
    }
    await _closePanel(cancelIfRequesting: false);
  }

  /// Polished, temporary apology ("We're Sorry … finding you another
  /// driver") — auto-dismisses, then the same search sheet keeps working.
  void _showDriverCancelledApology() {
    showDriverCancelledApology(context);
  }

  /// Ride Credits toggle with a zero balance: shake + red pulse so the
  /// rider understands why the switch is inert.
  void _triggerZeroCreditsFeedback() {
    _creditsZeroTimer?.cancel();
    setState(() {
      _creditsZeroFeedback = true;
    });
    _creditsShakeController.forward(from: 0);
    _creditsZeroTimer = Timer(const Duration(milliseconds: 1400), () {
      if (mounted) {
        setState(() => _creditsZeroFeedback = false);
      }
    });
  }

  void _openWalletScreen() {
    Navigator.of(context).push(
      MaterialPageRoute(
        fullscreenDialog: true,
        builder: (_) => const WalletScreen(),
      ),
    );
  }

  // ---------------------------------------------------------------------
  // Part 3 — draggable bottom sheet mechanics.
  // ---------------------------------------------------------------------

  double _sheetHeightForFraction(double t) {
    final maxH = MediaQuery.sizeOf(context).height * _sheetMaxFraction;
    return _sheetMinHeight + (maxH - _sheetMinHeight) * t;
  }

  void _animateSheetTo(double target) {
    _sheetController.animateTo(
      target.clamp(0.0, 1.0),
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeOutCubic,
    );
  }

  void _onSheetDragStart(DragStartDetails details) {
    _dragStartFraction = _sheetController.value;
  }

  void _onSheetDragUpdate(DragUpdateDetails details) {
    final maxH = MediaQuery.sizeOf(context).height * _sheetMaxFraction;
    final range = maxH - _sheetMinHeight;
    if (range <= 0) return;
    final deltaFrac = -details.delta.dy / range;
    _sheetController.value = (_dragStartFraction + deltaFrac)
        .clamp(0.0, 1.0)
        .toDouble();
  }

  void _onSheetDragEnd(DragEndDetails details) {
    final velocity = details.primaryVelocity ?? 0;
    final v = _sheetController.value;
    final target = velocity.abs() > 350
        ? (velocity < 0 ? 1.0 : 0.0)
        : (v > 0.45 ? 1.0 : 0.0);
    _animateSheetTo(target);
  }

  @override
  Widget build(BuildContext context) {
    final rideProvider = Provider.of<RideProvider>(context);
    final theme = Theme.of(context);

    // Eligible active specials — the single authoritative list shared by
    // the Explore SPECIALS section and these map markers. Zero active
    // specials ⇒ zero markers (hidden, not placeholders).
    final eligibleSponsors = context
        .select<SpecialsProvider, List<SponsorSpecial>>(
          (s) => s.sponsors
              .where((x) => x.latitude != null && x.longitude != null)
              .toList(),
        );
    // The selected special id drives the red marker AND the card highlight
    // from one place (spec §15/§30).
    final selectedSponsorId = context.select<SpecialsProvider, String?>(
      (s) => s.selectedSpecialId,
    );

    // When a driver accepts, leave the map and go to the active trip
    // screen. Covers BOTH the initial request (`_requesting`) and a resumed
    // search after a driver cancellation (`_resumedSearchTripId` engaged):
    // the ride staying on this map is only ever a SEARCHING state. The
    // sheet being open is the single requirement — a ride accepted for
    // this rider while this sheet is up always lands on the trip screen.
    final acceptedByMapFlow =
        _panelOpen &&
        rideProvider.tripId != null &&
        rideProvider.status == models.TripStatus.ACCEPTED;
    if (acceptedByMapFlow && !_hasNavigatedToTrip) {
      _hasNavigatedToTrip = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) Navigator.pushReplacementNamed(context, '/trip');
      });
    }

    // Re-attach to an already-searchable ride (backend REQUESTED with a
    // known trip id): the SAME search sheet used for the initial request
    // takes over — driver-cancel recovery, cold-start re-attach, or the
    // rider returning to Explore mid-search all funnel into this one state.
    if (rideProvider.isSearchingForDriver) {
      if (rideProvider.tripId != _resumedSearchTripId) {
        _resumedSearchTripId = rideProvider.tripId;
        if (_panelOpen) {
          // Sheet already open (initial request flow) — nothing to do.
        } else {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (!mounted) return;
            setState(() => _panelOpen = true);
          });
        }
      }
      if (_hasNavigatedToTrip) {
        // We came back from the trip screen (the accepted driver cancelled
        // and released the ride, or the rider aborted there) — this map
        // re-owns the same ride's search, so the next ACCEPTED may
        // navigate to the trip screen again.
        _hasNavigatedToTrip = false;
      }
    }

    // Auto-close the ride panel when the ride status returns to IDLE after
    // a cancellation — whether the search was locally initiated, resumed
    // after a driver cancel, or cancelled from the TripScreen.
    if (_panelOpen &&
        (_requesting || _resumedSearchTripId != null) &&
        rideProvider.status == models.TripStatus.IDLE) {
      _hasNavigatedToTrip = true; // prevent re-entry
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _closePanel(cancelIfRequesting: false);
      });
    }

    // Driver cancelled after acceptance: the backend released the SAME ride
    // back to searching and keeps re-dispatching it — the searching sheet
    // stays up ("Finding your driver…"). Pop the apology dialog exactly
    // once per driver cancellation (notice id is monotonic).
    final pendingNotice = rideProvider.driverCancelledNotice;
    if (pendingNotice != null &&
        rideProvider.isSearchingForDriver &&
        rideProvider.driverCancelledNoticeSeq !=
            _driverCancelNotifiedNoticeId) {
      _driverCancelNotifiedNoticeId = rideProvider.driverCancelledNoticeSeq;
      rideProvider.consumeDriverCancelledNotice();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _showDriverCancelledApology();
      });
    }

    return Scaffold(
      body: StateContainer(
        state: _state,
        errorMessage: _errorMessage,
        onRetry: _initLiveLocation,
        successWidget: LayoutBuilder(
          builder: (context, constraints) {
            final fullMapHeight = constraints.maxHeight;
            final miniMapHeight = (fullMapHeight * 0.40).clamp(240.0, 380.0);
            return Stack(
              children: [
                Column(
                  children: [
                    // Part 2: the WHOLE Explore page scrolls as one unit — greeting,
                    // search cards, SPECIALS and the map. The map keeps a
                    // fixed height (specials never shrink it) and moves with
                    // the page like everything else. Tapping the mini map
                    // expands it to full screen; in full-screen mode the
                    // rest of the page collapses and the map fills the
                    // screen (still scrollable as one page).
                    Expanded(
                      child: LayoutBuilder(
                        builder: (context, viewport) {
                          final vpHeight = viewport.maxHeight;
                          final vpInsets = MediaQuery.paddingOf(context);
                          return SingleChildScrollView(
                        physics: const BouncingScrollPhysics(),
                        padding: const EdgeInsets.only(bottom: 24),
                        child: SafeArea(
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 20,
                              vertical: 10,
                            ),
                            // When the page content is shorter than the
                            // viewport (e.g. no active specials), fill the
                            // height and center the content so the map stays
                            // near the middle instead of drifting up with
                            // blank space beneath it.
                            child: ConstrainedBox(
                              constraints: BoxConstraints(
                                minHeight: _mapExpanded
                                    ? 0
                                    : math.max(
                                        0.0,
                                        vpHeight -
                                            vpInsets.top -
                                            vpInsets.bottom,
                                      ),
                              ),
                              child: Column(
                                mainAxisAlignment: _mapExpanded
                                    ? MainAxisAlignment.start
                                    : MainAxisAlignment.center,
                                crossAxisAlignment:
                                    CrossAxisAlignment.stretch,
                              children: [
                                if (!_mapExpanded) ...[
                                  Row(
                                    mainAxisAlignment:
                                        MainAxisAlignment.spaceBetween,
                                    children: [
                                      Container(
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 16,
                                          vertical: 8,
                                        ),
                                        decoration: BoxDecoration(
                                          color: Colors.white,
                                          borderRadius: BorderRadius.circular(
                                            24,
                                          ),
                                          boxShadow: [
                                            BoxShadow(
                                              color: Colors.black.withOpacity(
                                                0.05,
                                              ),
                                              blurRadius: 10,
                                              offset: const Offset(0, 4),
                                            ),
                                          ],
                                        ),
                                        child: Text(
                                          _firstName.isNotEmpty
                                              ? 'Hello, $_firstName'
                                              : 'Welcome',
                                          style: theme.textTheme.bodyMedium
                                              ?.copyWith(
                                                fontWeight: FontWeight.w600,
                                                color: const Color(0xFF2F3A32),
                                              ),
                                        ),
                                      ),
                                      Container(
                                        width: 12,
                                        height: 12,
                                        decoration: BoxDecoration(
                                          color: rideProvider.isConnected
                                              ? const Color(0xFF6E8B74)
                                              : const Color(0xFFC65A5A),
                                          shape: BoxShape.circle,
                                          border: Border.all(
                                            color: Colors.white,
                                            width: 2,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 14),
                                  _buildExploreLocationCard(theme),
                                  const SizedBox(height: 10),
                                  Hero(
                                    tag: 'search_container',
                                    child: _buildWhereToCard(theme),
                                  ),
                                  // Small breathing room below the destination
                                  // cards: the greeting/cards stay pinned to the
                                  // top, while recents, specials and the map sit
                                  // slightly lower. The rest of the spare height
                                  // stays at the bottom, so short pages (no
                                  // specials) feel balanced instead of having all
                                  // the empty space under the map.
                                  const SizedBox(height: 28),
                                  if (_recentSearches.isNotEmpty) ...[
                                    const SizedBox(height: 14),
                                    _buildRecentSearches(theme),
                                  ],
                                  // SPECIAL CODES — open validation cards
                                  // (one per completed special ride) between
                                  // Recents and SPECIALS. Renders nothing
                                  // when no code is pending validation.
                                  const ExploreValidationSection(),
                                  // SPECIALS — conditional section living INSIDE
                                  // Explore. Renders nothing when the backend
                                  // reports zero eligible active specials (the
                                  // widget's own visibility rule), so Explore
                                  // stays clean in both cases.
                                  const ExploreSpecialsSection(),
                                ], // end of the non-fullscreen spread
                                const SizedBox(height: 14),
                                if (_smoothedPosition != null)
                                  AnimatedSize(
                                    duration: const Duration(milliseconds: 380),
                                    curve: Curves.easeInOutCubic,
                                    alignment: Alignment.topCenter,
                                    child: SizedBox(
                                      height: _mapExpanded
                                          ? fullMapHeight
                                          : miniMapHeight,
                                      child: AnimatedPadding(
                                        duration: const Duration(
                                          milliseconds: 380,
                                        ),
                                        curve: Curves.easeInOutCubic,
                                        padding: _mapExpanded
                                            ? EdgeInsets.zero
                                            : const EdgeInsets.only(bottom: 4),
                                        child: AnimatedContainer(
                                          duration: const Duration(
                                            milliseconds: 380,
                                          ),
                                          curve: Curves.easeInOutCubic,
                                          clipBehavior: Clip.antiAlias,
                                          decoration: BoxDecoration(
                                            borderRadius: BorderRadius.circular(
                                              _mapExpanded ? 0 : 28,
                                            ),
                                            boxShadow: _mapExpanded
                                                ? null
                                                : [
                                                    BoxShadow(
                                                      color: Colors.black
                                                          .withOpacity(0.10),
                                                      blurRadius: 24,
                                                      offset: const Offset(
                                                        0,
                                                        10,
                                                      ),
                                                    ),
                                                  ],
                                          ),
                                          child: Stack(
                                            children: [
                                              Listener(
                                                // In mini mode a light tap expands the map
                                                // (state A -> B); drags and pinches pan/zoom the
                                                // map directly (interaction enabled below). Raw
                                                // pointer events are used because flutter_map's
                                                // tap recognizer would win the gesture arena
                                                // against a wrapping GestureDetector.
                                                onPointerDown: _mapExpanded
                                                    ? null
                                                    : (e) {
                                                        _miniTapDownPosition =
                                                            e.position;
                                                        _miniTapDownAt =
                                                            DateTime.now();
                                                      },
                                                onPointerUp: _mapExpanded
                                                    ? null
                                                    : (e) {
                                                        final down =
                                                            _miniTapDownPosition;
                                                        final downAt =
                                                            _miniTapDownAt;
                                                        _miniTapDownPosition =
                                                            null;
                                                        _miniTapDownAt = null;
                                                        if (down == null ||
                                                            downAt == null)
                                                          return;
                                                        final moved =
                                                            (e.position - down)
                                                                .distance;
                                                        final elapsed =
                                                            DateTime.now()
                                                                .difference(
                                                                  downAt,
                                                                );
                                                        if (moved < 16 &&
                                                            elapsed <
                                                                const Duration(
                                                                  milliseconds:
                                                                      400,
                                                                )) {
                                                          _expandMap();
                                                        }
                                                      },
                                                child: FlutterMap(
                                                  mapController: _mapController,
                                                  options: MapOptions(
                                                    initialCenter:
                                                        _smoothedPosition!,
                                                    initialZoom: 15.0,
                                                    minZoom: 12,
                                                    maxZoom: 18,
                                                    interactionOptions:
                                                        InteractionOptions(
                                                          flags: _mapExpanded
                                                              ? InteractiveFlag
                                                                        .all &
                                                                    ~InteractiveFlag
                                                                        .rotate
                                                              : InteractiveFlag
                                                                    .none,
                                                        ),
                                                    onMapReady: () {
                                                      setState(
                                                        () =>
                                                            _isMapReady = true,
                                                      );
                                                    },
                                                    onPositionChanged:
                                                        (pos, hasGesture) {
                                                          if (hasGesture) {
                                                            setState(
                                                              () =>
                                                                  _shouldFollowUser =
                                                                      false,
                                                            );
                                                          }
                                                        },
                                                  ),
                                                  children: [
                                                    TileLayer(
                                                      urlTemplate:
                                                          'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
                                                      maxNativeZoom: 16,
                                                      userAgentPackageName:
                                                          'com.NetRide.rider',
                                                      tileBuilder:
                                                          brandedMapTile,
                                                    ),
                                                    AnimatedOpacity(
                                                      opacity:
                                                          _routePoints
                                                              .isNotEmpty
                                                          ? 1
                                                          : 0,
                                                      duration: const Duration(
                                                        milliseconds: 350,
                                                      ),
                                                      child:
                                                          _routePoints.isEmpty
                                                          ? const SizedBox.shrink()
                                                          : PolylineLayer(
                                                              polylines: [
                                                                Polyline<
                                                                  Object
                                                                >(
                                                                  points:
                                                                      _routePoints,
                                                                  color: const Color(
                                                                    0xFF5B7760,
                                                                  ),
                                                                  strokeWidth:
                                                                      4.0,
                                                                  borderColor:
                                                                      Colors
                                                                          .white,
                                                                  borderStrokeWidth:
                                                                      1.0,
                                                                ),
                                                              ],
                                                            ),
                                                    ),
                                                    MarkerLayer(
                                                      markers: [
                                                        if (_smoothedPosition !=
                                                            null)
                                                          Marker(
                                                            point:
                                                                _smoothedPosition!,
                                                            width: 40,
                                                            height: 40,
                                                            child:
                                                                _buildUserLocationMarker(),
                                                          ),
                                                        if (_pickup != null &&
                                                            _pickup!.address !=
                                                                'Current Location')
                                                          Marker(
                                                            point: LatLng(
                                                              _pickup!.lat,
                                                              _pickup!.lng,
                                                            ),
                                                            width: 30,
                                                            height: 30,
                                                            child:
                                                                _buildPinMarker(
                                                                  const Color(
                                                                    0xFF5B7760,
                                                                  ),
                                                                  isPickup:
                                                                      true,
                                                                ),
                                                          ),
                                                        if (_destination !=
                                                            null)
                                                          Marker(
                                                            point: LatLng(
                                                              _destination!.lat,
                                                              _destination!.lng,
                                                            ),
                                                            width: 30,
                                                            height: 30,
                                                            child:
                                                                _buildPinMarker(
                                                                  const Color(
                                                                    0xFF2F3A32,
                                                                  ),
                                                                  isPickup:
                                                                      false,
                                                                ),
                                                          ),
                                                        // SPECIALS sponsor markers (eligible active
                                                        // specials only — deactivated sponsors drop
                                                        // out of the list on the next refresh, so zero
                                                        // active specials means zero markers).
                                                        for (final s
                                                            in eligibleSponsors)
                                                          Marker(
                                                            point: LatLng(
                                                              s.latitude!,
                                                              s.longitude!,
                                                            ),
                                                            width:
                                                                selectedSponsorId ==
                                                                    s.id
                                                                ? 48
                                                                : 36,
                                                            height:
                                                                selectedSponsorId ==
                                                                    s.id
                                                                ? 48
                                                                : 36,
                                                            child: GestureDetector(
                                                              behavior:
                                                                  HitTestBehavior
                                                                      .opaque,
                                                              onTap: () =>
                                                                  SpecialBusinessSheet.show(
                                                                    context,
                                                                    sponsor: s,
                                                                  ),
                                                              child:
                                                                  _buildSponsorMarker(
                                                                    s,
                                                                    selected:
                                                                        selectedSponsorId ==
                                                                        s.id,
                                                                  ),
                                                            ),
                                                          ),
                                                      ],
                                                    ),
                                                    for (var entry
                                                        in rideProvider
                                                            .nearbyDrivers
                                                            .entries)
                                                      SmoothDriverMarker(
                                                        driverId: entry.key,
                                                        position: LatLng(
                                                          entry.value.lat,
                                                          entry.value.lng,
                                                        ),
                                                        heading:
                                                            entry
                                                                .value
                                                                .heading ??
                                                            0,
                                                      ),
                                                  ],
                                                ),
                                              ),
                                              // Tap-to-expand hint pill — glued to the mini map
                                              // so it stays with it (state A).
                                              if (!_mapExpanded)
                                                Positioned(
                                                  top: 10,
                                                  right: 10,
                                                  child: IgnorePointer(
                                                    child: Container(
                                                      padding:
                                                          const EdgeInsets.symmetric(
                                                            horizontal: 12,
                                                            vertical: 6,
                                                          ),
                                                      decoration: BoxDecoration(
                                                        color: Colors.white
                                                            .withOpacity(0.92),
                                                        borderRadius:
                                                            BorderRadius.circular(
                                                              999,
                                                            ),
                                                        border: Border.all(
                                                          color: const Color(
                                                            0xFFD8D2CA,
                                                          ),
                                                        ),
                                                        boxShadow: [
                                                          BoxShadow(
                                                            color: Colors.black
                                                                .withOpacity(
                                                                  0.06,
                                                                ),
                                                            blurRadius: 8,
                                                            offset:
                                                                const Offset(
                                                                  0,
                                                                  3,
                                                                ),
                                                          ),
                                                        ],
                                                      ),
                                                      child: const Row(
                                                        mainAxisSize:
                                                            MainAxisSize.min,
                                                        children: [
                                                          Icon(
                                                            Icons
                                                                .open_in_full_rounded,
                                                            size: 12,
                                                            color: Color(
                                                              0xFF5B7760,
                                                            ),
                                                          ),
                                                          SizedBox(width: 5),
                                                          Text(
                                                            'Tap map for full screen · scroll to explore',
                                                            style: TextStyle(
                                                              fontSize: 10.5,
                                                              fontWeight:
                                                                  FontWeight
                                                                      .w700,
                                                              color: Color(
                                                                0xFF5B7760,
                                                              ),
                                                            ),
                                                          ),
                                                        ],
                                                      ),
                                                    ),
                                                  ),
                                                ),
                                            ],
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    );
                      },
                    ),
                  ),
                ],
              ),

                // Part 2: back arrow — only in full-screen map mode (B/C) AND when the
                // choose-your-ride panel is closed. The panel has no top-left
                // arrow; its Cancel button is the way out.
                if (_mapExpanded && !_panelOpen)
                  Positioned(
                    top: 0,
                    left: 0,
                    child: SafeArea(
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Material(
                          color: Colors.white,
                          shape: const CircleBorder(),
                          elevation: 3,
                          shadowColor: Colors.black.withOpacity(0.2),
                          child: InkWell(
                            customBorder: const CircleBorder(),
                            onTap: _collapseMap,
                            child: const Padding(
                              padding: EdgeInsets.all(10),
                              child: Icon(
                                Icons.arrow_back_rounded,
                                size: 20,
                                color: Color(0xFF2F3A32),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),

                // Tap-to-expand hint pill lives INSIDE the mini map (above).

                // My-location FAB — rides above the bottom sheet when open.
                AnimatedBuilder(
                  animation: _sheetController,
                  builder: (context, _) {
                    // The sheet also renders for an on-going backend search even
                    // when the local pickup/destination are gone (fresh Explore
                    // after a driver-cancel recovery re-attaches to the ride).
                    final searchingOnMap =
                        _requesting || rideProvider.isSearchingForDriver;
                    final sheetOpen =
                        _panelOpen &&
                        (searchingOnMap ||
                            (_pickup != null && _destination != null));
                    final sheetHeight = sheetOpen
                        ? _sheetHeightForFraction(_sheetController.value)
                        : 0.0;
                    return Positioned(
                      right: 20,
                      bottom: sheetOpen
                          ? sheetHeight + 16
                          : (_mapExpanded ? 24 : 40),
                      child: FloatingActionButton(
                        heroTag: 'location_fab',
                        backgroundColor: Colors.white,
                        foregroundColor: const Color(0xFF2F3A32),
                        elevation: 4,
                        shape: const CircleBorder(),
                        onPressed: () {
                          setState(() => _shouldFollowUser = true);
                          if (_smoothedPosition != null) {
                            _mapController.move(_smoothedPosition!, 15.0);
                          }
                        },
                        child: const Icon(Icons.my_location),
                      ),
                    );
                  },
                ),

                if (_panelOpen &&
                    (_pickup != null && _destination != null ||
                        _requesting ||
                        rideProvider.isSearchingForDriver))
                  _buildRideSheet(theme)
                else if (_pickup != null && _destination != null)
                  Positioned(
                    bottom: 40,
                    left: 20,
                    right: 20,
                    child: Hero(
                      tag: 'confirm_button',
                      child: SizedBox(
                        width: double.infinity,
                        child: ElevatedButton(
                          onPressed: _openRidePanel,
                          child: const Text('See Ride Options'),
                        ),
                      ),
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }

  /// Part 3 — the draggable ride-selection bottom sheet. Collapsed it shows
  /// a centered pill handle with a compact summary (luxury car + class +
  /// price); dragging (or tapping the pill) expands the full options: car
  /// card with animated price reduction, promo + credits panel, confirm CTA.
  Widget _buildRideSheet(ThemeData theme) {
    final rideProvider = Provider.of<RideProvider>(context);
    // ONE searching predicate for the sheet: the initial request
    // (optimistic local flag until the backend confirms) OR any ride the
    // backend is still matching (initial + resumed after driver cancel).
    final searching =
        rideProvider.status == models.TripStatus.REQUESTED &&
        (_requesting || rideProvider.isSearchingForDriver);

    return Positioned(
      bottom: 0,
      left: 0,
      right: 0,
      child: GestureDetector(
        onVerticalDragStart: _onSheetDragStart,
        onVerticalDragUpdate: _onSheetDragUpdate,
        onVerticalDragEnd: _onSheetDragEnd,
        child: AnimatedBuilder(
          animation: _sheetController,
          builder: (context, _) {
            final t = _sheetController.value;
            final height = _sheetHeightForFraction(t);
            final isCollapsed = t < 0.05;

            return SizedBox(
              height: height,
              child: Container(
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: const BorderRadius.vertical(
                    top: Radius.circular(24),
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withOpacity(0.14),
                      blurRadius: 24,
                      offset: const Offset(0, -8),
                    ),
                  ],
                ),
                clipBehavior: Clip.hardEdge,
                child: isCollapsed
                    ? _buildSheetPill(theme)
                    : _buildSheetBody(theme, searching: searching),
              ),
            );
          },
        ),
      ),
    );
  }

  /// Collapsed state: centered drag handle + one-line ride summary.
  Widget _buildSheetPill(ThemeData theme) {
    // Calculation in flight → "Calculating…" (§6). No backend fare available
    // after calculation (offline / cached plan without fare) → an em dash
    // instead of a locally-computed or $0.00 price.
    final priceText = _loadingEstimates
        ? 'Calculating…'
        : (_estimateFare <= 0
              ? '—'
              : (_finalCents >= 0
                    ? formatCents(_finalCents)
                    : '\$${_estimateFare.toStringAsFixed(2)}'));
    return GestureDetector(
      onTap: () => _animateSheetTo(1),
      behavior: HitTestBehavior.opaque,
      child: FittedBox(
        fit: BoxFit.scaleDown,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 38,
              height: 5,
              decoration: BoxDecoration(
                color: Colors.grey.shade300,
                borderRadius: BorderRadius.circular(999),
              ),
            ),
            const SizedBox(height: 10),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(6),
                  child: Image.asset(
                    'assets/images/car-logo.png',
                    width: 68,
                    height: 36,
                    fit: BoxFit.contain,
                  ),
                ),
                const SizedBox(width: 10),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'NetRide Premium',
                      style: TextStyle(
                        fontWeight: FontWeight.w800,
                        fontSize: 13,
                        color: Color(0xFF2F3A32),
                      ),
                    ),
                    if (_estimateFare > 0)
                      Text(
                        'Est. ${(_estimateDurationSeconds / 60).round().clamp(1, 99)} min',
                        style: TextStyle(
                          fontSize: 10.5,
                          color: Colors.grey.shade600,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                  ],
                ),
                const SizedBox(width: 12),
                Text(
                  priceText,
                  style: const TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w800,
                    color: Color(0xFF2F3A32),
                    letterSpacing: -0.4,
                  ),
                ),
                const SizedBox(width: 6),
                Icon(
                  Icons.keyboard_arrow_up_rounded,
                  size: 20,
                  color: Colors.grey.shade500,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  /// Expanded state: full ride-selection UI with scrollable content and
  /// a fixed confirm button pinned to the bottom (never overflows).
  Widget _buildSheetBody(ThemeData theme, {required bool searching}) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    final cancelling = Provider.of<RideProvider>(context).cancelling;
    final requestFailure = Provider.of<RideProvider>(context).requestFailure;

    return Column(
      children: [
        const SizedBox(height: 10),
        Container(
          width: 38,
          height: 5,
          decoration: BoxDecoration(
            color: Colors.grey.shade300,
            borderRadius: BorderRadius.circular(999),
          ),
        ),
        const SizedBox(height: 6),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 6, 12, 0),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  searching ? 'Finding your driver…' : 'Choose your ride',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                    color: const Color(0xFF2F3A32),
                  ),
                ),
              ),
              if (cancelling)
                const Padding(
                  padding: EdgeInsets.all(8),
                  child: SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Color(0xFF5B7760),
                    ),
                  ),
                )
              else
                TextButton(
                  onPressed: _closePanel,
                  style: TextButton.styleFrom(
                    foregroundColor: const Color(0xFF5B7760),
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                    side: const BorderSide(color: Color(0xFF5B7760)),
                  ),
                  child: const Text(
                    'Cancel',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 6),
        if (_loadingEstimates)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 24),
            child: CircularProgressIndicator(color: Color(0xFF5B7760)),
          )
        else if (searching)
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(vertical: 20),
              child: requestFailure != null
                  ? Column(
                      children: [
                        const Icon(
                          Icons.error_outline_rounded,
                          size: 40,
                          color: Color(0xFFC65A5A),
                        ),
                        const SizedBox(height: 14),
                        Text(
                          'Ride request failed',
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.w800,
                            color: const Color(0xFF2F3A32),
                          ),
                        ),
                        const SizedBox(height: 8),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 28),
                          child: Text(
                            requestFailure!,
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              fontSize: 13.5,
                              height: 1.4,
                              color: const Color(0xFF2F3A32).withOpacity(0.75),
                            ),
                          ),
                        ),
                        const SizedBox(height: 20),
                        OutlinedButton.icon(
                          onPressed: () {
                            Provider.of<RideProvider>(
                              context,
                              listen: false,
                            ).clearRequestFailure();
                            _closePanel(cancelIfRequesting: false);
                          },
                          icon: const Icon(
                            Icons.close,
                            size: 18,
                            color: Color(0xFF5B7760),
                          ),
                          label: const Text(
                            'Close',
                            style: TextStyle(
                              color: Color(0xFF5B7760),
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          style: OutlinedButton.styleFrom(
                            side: const BorderSide(color: Color(0xFF5B7760)),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12),
                            ),
                            padding: const EdgeInsets.symmetric(
                              horizontal: 22,
                              vertical: 12,
                            ),
                          ),
                        ),
                      ],
                    )
                  : Column(
                      children: [
                        const SizedBox(
                          width: 36,
                          height: 36,
                          child: CircularProgressIndicator(
                            strokeWidth: 3,
                            color: Color(0xFF5B7760),
                          ),
                        ),
                        const SizedBox(height: 16),
                        const Text(
                          'Matching you with nearby drivers…',
                          style: TextStyle(
                            fontWeight: FontWeight.w600,
                            color: Color(0xFF2F3A32),
                          ),
                        ),
                        const SizedBox(height: 24),
                        if (cancelling)
                          const Text(
                            'Cancelling ride request…',
                            style: TextStyle(
                              fontWeight: FontWeight.w600,
                              fontSize: 13,
                              color: Color(0xFFC65A5A),
                            ),
                          )
                        else
                          OutlinedButton.icon(
                            onPressed: _requestCancel,
                            icon: const Icon(
                              Icons.close,
                              size: 18,
                              color: Color(0xFFC65A5A),
                            ),
                            label: const Text(
                              'Cancel Ride',
                              style: TextStyle(
                                color: Color(0xFFC65A5A),
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            style: OutlinedButton.styleFrom(
                              side: const BorderSide(color: Color(0xFFE5B9B9)),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(12),
                              ),
                              padding: const EdgeInsets.symmetric(
                                horizontal: 22,
                                vertical: 12,
                              ),
                            ),
                          ),
                      ],
                    ),
            ),
          )
        else
          Expanded(
            child: SingleChildScrollView(
              padding: EdgeInsets.fromLTRB(20, 0, 20, 12),
              child: Column(
                children: [
                  _buildRideCard(theme),
                  const SizedBox(height: 10),
                  _buildRewardsPanel(theme),
                  SizedBox(height: 14 + bottomInset),
                ],
              ),
            ),
          ),
        if (!_loadingEstimates && !searching) ...[
          // SPECIALS: when the rider has a CREATED redemption, the checkout
          // advertises the applied special right above the confirm button.
          Builder(
            builder: (context) {
              final attachable = context
                  .select<SpecialsProvider, SpecialRedemption?>(
                    (s) => s.canAttachToRide ? s.current : null,
                  );
              if (attachable == null) return const SizedBox.shrink();
              return Padding(
                padding: EdgeInsets.fromLTRB(20, 0, 20, 10),
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 9,
                  ),
                  decoration: BoxDecoration(
                    color: const Color(0xFF5B7760).withOpacity(0.12),
                    borderRadius: BorderRadius.circular(30),
                    border: Border.all(color: const Color(0xFF5B7760)),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(
                        Icons.storefront_rounded,
                        size: 16,
                        color: Color(0xFF5B7760),
                      ),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(
                          'SPECIAL at ${attachable.sponsorName} — '
                          '${attachable.discountLabel.isEmpty ? 'save on this ride' : '${attachable.discountLabel} off'}',
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w700,
                            color: Color(0xFF5B7760),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
          Padding(
            padding: EdgeInsets.fromLTRB(20, 0, 20, 18 + bottomInset),
            child: SizedBox(
              width: double.infinity,
              height: 54,
              child: ElevatedButton(
                onPressed: _confirmRide,
                style: ElevatedButton.styleFrom(
                  backgroundColor: _creditsToUseCents > 0
                      ? const Color(0xFF4CAF50)
                      : const Color(0xFF2F3A32),
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14),
                  ),
                ),
                child: Text(
                  _creditsToUseCents > 0
                      ? 'Confirm with ride credits'
                      : 'Confirm NetRide Premium',
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.5,
                  ),
                ),
              ),
            ),
          ),
        ],
      ],
    );
  }

  /// Loads the rider's credit balance once per session.
  /// Called from initState (not from build) so drag/rebuild frames never
  /// trigger a network fetch.
  Future<void> _loadRewardsOptions() async {
    if (_creditBalanceLoaded) return;
    try {
      final account = await RewardsService.getCredits();
      if (!mounted) return;
      setState(() {
        _creditBalanceCents = account.balanceCents;
        _creditBalanceLoaded = true;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _creditBalanceLoaded = true;
      });
    }
  }

  Future<void> _validatePromo() async {
    final code = _promoCodeController.text.trim();
    if (code.isEmpty) return;
    setState(() {
      _promoChecking = true;
      _promoPreview = null;
    });
    try {
      final preview = await RewardsService.validatePromo(
        code,
        distanceMeters: null,
        durationSeconds: null,
      );
      if (!mounted) return;
      setState(() {
        _promoPreview = preview;
        _promoChecking = false;
        _promoApplied = preview.valid;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _promoChecking = false;
        _promoApplied = false;
      });
    }
  }

  /// Small banner inside the checkout panel announcing the attached special.
  /// Replaces the promo-code row: a special ride never combines with a promo.
  Widget _buildSpecialBanner(ThemeData theme) {
    final redemption = Provider.of<SpecialsProvider>(
      context,
      listen: false,
    ).current;
    final name = (redemption?.sponsorName?.isNotEmpty ?? false)
        ? redemption!.sponsorName!
        : 'Your deal';
    final label = (redemption?.discountLabel?.isNotEmpty ?? false)
        ? redemption!.discountLabel!
        : 'SPECIAL';
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(
              color: const Color(0xFF5B7760).withOpacity(0.12),
              borderRadius: BorderRadius.circular(10),
            ),
            child: const Icon(
              Icons.local_activity_rounded,
              size: 18,
              color: Color(0xFF5B7760),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Special attached — $name',
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: Color(0xFF2F3A32),
                  ),
                ),
                const SizedBox(height: 1),
                Text(
                  '$label off this ride · no promo code needed',
                  style: TextStyle(
                    fontSize: 11.5,
                    color: const Color(0xFF2F3A32).withOpacity(0.6),
                  ),
                ),
                const SizedBox(height: 10),
                // REQUIRED consent for the conditional no-show charge:
                // $label is only applied if the sponsor validates the visit
                // code; otherwise the remaining fare is collected.
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Checkbox(
                      value: _specialTermsAccepted,
                      onChanged: (v) => setState(() {
                        _specialTermsAccepted = v ?? false;
                      }),
                      visualDensity: VisualDensity.compact,
                    ),
                    Expanded(
                      child: Text(
                        'I understand: if the sponsor code is not validated '
                        'before the deadline, the remaining fare (up to the '
                        'full ride price) may be charged to my payment method.',
                        style: TextStyle(
                          fontSize: 11,
                          color: const Color(0xFF2F3A32).withOpacity(0.75),
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// Compact promo + credits + payment options shown at checkout.
  /// Ride credits default OFF; turning ON reveals a precise amount input.
  Widget _buildRewardsPanel(ThemeData theme) {
    final balanceCents = _creditBalanceCents ?? 0;
    final hasCredits = balanceCents > 0;

    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFD8D2CA)),
      ),
      child: Column(
        children: [
          // --- Promo Code (disabled while a special is attached) ---
          if (_specialAttached)
            _buildSpecialBanner(theme)
          else
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              child: Row(
                children: [
                  const Icon(
                    Icons.local_offer_outlined,
                    size: 18,
                    color: Color(0xFF5B7760),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: TextField(
                      controller: _promoCodeController,
                      textCapitalization: TextCapitalization.characters,
                      // Uppercase the code while typing (not just the mobile
                      // keyboard) so the Apply/preview and backend lookup are
                      // always consistent.
                      inputFormatters: [
                        TextInputFormatter.withFunction((oldValue, newValue) {
                          final upper = newValue.text.toUpperCase();
                          if (upper == newValue.text) return newValue;
                          return TextEditingValue(
                            text: upper,
                            selection: newValue.selection,
                            composing: TextRange.empty,
                          );
                        }),
                      ],
                      decoration: const InputDecoration(
                        hintText: 'Promo code',
                        isDense: true,
                        border: InputBorder.none,
                      ),
                      style: const TextStyle(
                        fontSize: 14,
                        color: Color(0xFF2F3A32),
                      ),
                      onSubmitted: (_) => _validatePromo(),
                    ),
                  ),
                  if (_promoChecking)
                    const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Color(0xFF5B7760),
                      ),
                    )
                  else if (_promoApplied)
                    const Icon(
                      Icons.check_circle_rounded,
                      color: Color(0xFF6E8B74),
                      size: 20,
                    )
                  else
                    TextButton(
                      onPressed: _validatePromo,
                      child: const Text('Apply'),
                    ),
                ],
              ),
            ),
          if (_promoPreview != null &&
              _promoCodeController.text.trim().isNotEmpty) ...[
            const Divider(height: 1, indent: 14, endIndent: 14),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 6, 14, 6),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  _promoPreview!.valid
                      ? '${_promoPreview!.discountLabel ?? 'Discount'} applied'
                      : _promoPreview!.reason ?? 'Promo not available',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: _promoPreview!.valid
                        ? const Color(0xFF6E8B74)
                        : const Color(0xFFC65A5A),
                  ),
                ),
              ),
            ),
          ],
          const Divider(height: 1, indent: 14, endIndent: 14),
          // --- Favorite Driver ---
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            child: Row(
              children: [
                Icon(
                  _favoriteDriverEnabled
                      ? Icons.favorite_rounded
                      : Icons.favorite_outline_rounded,
                  size: 18,
                  color: _favoriteDriverEnabled
                      ? const Color(0xFFC65A5A)
                      : const Color(0xFF5B7760),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Text(
                        'Favorite Driver',
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                          color: Color(0xFF2F3A32),
                        ),
                      ),
                      Text(
                        _favoriteDriverEnabled
                            ? 'Prioritizing your favorite drivers'
                            : 'Prioritize your favorite drivers',
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w500,
                          color: _favoriteDriverEnabled
                              ? const Color(0xFF5B7760).withOpacity(0.7)
                              : Colors.grey.shade500,
                        ),
                      ),
                    ],
                  ),
                ),
                Switch(
                  value: _favoriteDriverEnabled,
                  activeTrackColor: const Color(0xFF5B7760),
                  onChanged: (v) => setState(() => _favoriteDriverEnabled = v),
                ),
              ],
            ),
          ),
          const Divider(height: 1, indent: 14, endIndent: 14),
          // --- Payment Method (no dollar balance) ---
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            child: Row(
              children: [
                const Icon(
                  Icons.credit_card_rounded,
                  size: 18,
                  color: Color(0xFF5B7760),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Payment Method',
                    style: const TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFF2F3A32),
                    ),
                  ),
                ),
                TextButton(
                  onPressed: _openWalletScreen,
                  child: const Text('Manage', style: TextStyle(fontSize: 12)),
                ),
              ],
            ),
          ),
          const Divider(height: 1, indent: 14, endIndent: 14),
          // --- Ride Credits (OFF by default; balance always visible) ---
          AnimatedBuilder(
            animation: _creditsShakeController,
            builder: (context, _) {
              final t = _creditsShakeController.value;
              final shake = hasCredits
                  ? 0.0
                  : math.sin(t * math.pi * 6) * 5 * (1 - t);
              return Transform.translate(
                offset: Offset(shake, 0),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 10,
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Row(
                        children: [
                          Icon(
                            _creditsZeroFeedback
                                ? Icons.error_outline_rounded
                                : Icons.account_balance_wallet_outlined,
                            size: 18,
                            color: _creditsZeroFeedback
                                ? const Color(0xFFC65A5A)
                                : const Color(0xFF5B7760),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                const Text(
                                  'Use Ride Credits',
                                  style: TextStyle(
                                    fontSize: 13,
                                    color: Color(0xFF2F3A32),
                                  ),
                                ),
                                Text(
                                  formatCents(balanceCents),
                                  style: TextStyle(
                                    fontSize: 11,
                                    fontWeight: FontWeight.w600,
                                    color: _creditsZeroFeedback
                                        ? const Color(0xFFC65A5A)
                                        : (hasCredits
                                              ? const Color(
                                                  0xFF5B7760,
                                                ).withOpacity(0.7)
                                              : Colors.grey.shade500),
                                  ),
                                ),
                              ],
                            ),
                          ),
                          Switch(
                            value: _applyCredits,
                            activeTrackColor: const Color(0xFF5B7760),
                            onChanged: hasCredits
                                ? (v) {
                                    setState(() {
                                      _applyCredits = v;
                                      if (!v) {
                                        _creditUseCents = null;
                                        _creditAmountError = null;
                                        _customCreditController.clear();
                                      }
                                    });
                                  }
                                : (_) => _triggerZeroCreditsFeedback(),
                          ),
                        ],
                      ),
                      if (_creditsZeroFeedback) ...[
                        const SizedBox(height: 6),
                        const Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            'No ride credits available',
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                              color: Color(0xFFC65A5A),
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              );
            },
          ),
          // --- Expanded credit amount input (when toggled ON) ---
          if (_applyCredits && hasCredits) ...[
            AnimatedSize(
              duration: const Duration(milliseconds: 250),
              curve: Curves.easeInOut,
              alignment: Alignment.topCenter,
              child: Column(
                children: [
                  const Divider(height: 1, indent: 14, endIndent: 14),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              'Available',
                              style: TextStyle(
                                fontSize: 12,
                                color: Colors.grey.shade600,
                              ),
                            ),
                            Text(
                              formatCents(balanceCents),
                              style: const TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w700,
                                color: Color(0xFF2F3A32),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Amount to use',
                          style: TextStyle(
                            fontSize: 12,
                            color: Colors.grey.shade600,
                          ),
                        ),
                        const SizedBox(height: 6),
                        Row(
                          children: [
                            Expanded(
                              child: TextField(
                                controller: _customCreditController,
                                keyboardType:
                                    const TextInputType.numberWithOptions(
                                      decimal: true,
                                    ),
                                decoration: InputDecoration(
                                  prefixText: '\$ ',
                                  hintText: '0.00',
                                  isDense: true,
                                  contentPadding: const EdgeInsets.symmetric(
                                    horizontal: 12,
                                    vertical: 10,
                                  ),
                                  border: OutlineInputBorder(
                                    borderRadius: BorderRadius.circular(10),
                                    borderSide: const BorderSide(
                                      color: Color(0xFFD8D2CA),
                                    ),
                                  ),
                                  enabledBorder: OutlineInputBorder(
                                    borderRadius: BorderRadius.circular(10),
                                    borderSide: const BorderSide(
                                      color: Color(0xFFD8D2CA),
                                    ),
                                  ),
                                  focusedBorder: OutlineInputBorder(
                                    borderRadius: BorderRadius.circular(10),
                                    borderSide: const BorderSide(
                                      color: Color(0xFF5B7760),
                                      width: 1.5,
                                    ),
                                  ),
                                ),
                                style: const TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w700,
                                  color: Color(0xFF2F3A32),
                                ),
                                onChanged: _onCreditAmountChanged,
                              ),
                            ),
                            if (_creditUseCents != null && _creditUseCents! > 0)
                              Padding(
                                padding: const EdgeInsets.only(left: 8),
                                child: TextButton(
                                  onPressed: () {
                                    setState(() {
                                      _creditUseCents = null;
                                      _creditAmountError = null;
                                      _customCreditController.clear();
                                    });
                                  },
                                  style: TextButton.styleFrom(
                                    foregroundColor: const Color(0xFFC65A5A),
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 8,
                                    ),
                                    minimumSize: Size.zero,
                                  ),
                                  child: const Text(
                                    'Clear',
                                    style: TextStyle(fontSize: 12),
                                  ),
                                ),
                              ),
                          ],
                        ),
                        if (_creditAmountError != null) ...[
                          const SizedBox(height: 6),
                          Text(
                            _creditAmountError!,
                            style: const TextStyle(
                              fontSize: 11.5,
                              fontWeight: FontWeight.w600,
                              color: Color(0xFFC65A5A),
                            ),
                          ),
                        ],
                        if (_creditUseCents != null &&
                            _creditUseCents! > 0 &&
                            _creditAmountError == null) ...[
                          const SizedBox(height: 8),
                          const Divider(height: 1),
                          const SizedBox(height: 8),
                          _creditBreakdownRow(
                            label: 'Original Fare',
                            amount: _fareCents,
                            positive: true,
                          ),
                          if (_promoDiscountCents > 0)
                            _creditBreakdownRow(
                              label: 'Promo discount',
                              amount: -_promoDiscountCents,
                              positive: false,
                            ),
                          _creditBreakdownRow(
                            label: 'Ride Credit',
                            amount: -_creditsToUseCents,
                            positive: false,
                          ),
                          const SizedBox(height: 4),
                          _creditBreakdownRow(
                            label: 'Final Fare',
                            amount: _finalCents,
                            positive: true,
                            bold: true,
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _creditBreakdownRow({
    required String label,
    required int amount,
    required bool positive,
    bool bold = false,
  }) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: bold ? FontWeight.w700 : FontWeight.w500,
                color: Colors.grey.shade700,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Text(
            positive ? formatCents(amount) : '-${formatCents(-amount)}',
            style: TextStyle(
              fontSize: 12.5,
              fontWeight: bold ? FontWeight.w800 : FontWeight.w600,
              color: bold
                  ? const Color(0xFF2F3A32)
                  : positive
                  ? const Color(0xFF2F3A32)
                  : const Color(0xFF5B7760),
            ),
          ),
        ],
      ),
    );
  }

  void _onCreditAmountChanged(String raw) {
    final balance = _creditBalanceCents ?? 0;
    final afterPromo = math.max(0, _fareCents - _promoDiscountCents);

    if (raw.isEmpty || raw == '.') {
      setState(() {
        _creditUseCents = null;
        _creditAmountError = null;
      });
      return;
    }

    final sanitized = raw.replaceAll(RegExp(r'[^0-9.]'), '');
    final dotCount = '.'.allMatches(sanitized).length;
    if (dotCount > 1) return;

    final dollars = double.tryParse(sanitized);
    if (dollars == null) return;

    final cents = (dollars * 100).round();

    if (cents <= 0) {
      setState(() {
        _creditUseCents = null;
        _creditAmountError = null;
      });
      return;
    }

    if (cents > balance) {
      setState(() {
        _creditUseCents = null;
        _creditAmountError =
            'You can use up to ${formatCents(balance)} in ride credits.';
      });
      return;
    }

    if (cents > afterPromo) {
      setState(() {
        _creditUseCents = null;
        _creditAmountError = "Ride credits can't exceed the current fare.";
      });
      return;
    }

    setState(() {
      _creditUseCents = cents;
      _creditAmountError = null;
    });
  }

  /// The single ride class card: premium SUV visual, class details, ETA,
  /// and the animated price breakdown (fare → promo → credits → final).
  Widget _buildRideCard(ThemeData theme) {
    final fareCents = _fareCents;
    final finalCents = _finalCents;
    final savedCents = _totalSavedCents;
    final etaMinutes = (_estimateDurationSeconds / 60).round().clamp(1, 99);

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: const Color(0xFF5B7760).withOpacity(0.08),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF5B7760), width: 2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Image.asset(
                  'assets/images/car-logo.png',
                  width: 149,
                  height: 95,
                  fit: BoxFit.contain,
                ),
              ),
              const SizedBox(width: 12),
              const Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'NetRide Premium',
                      style: TextStyle(
                        fontWeight: FontWeight.w800,
                        fontSize: 15,
                        color: Color(0xFF2F3A32),
                      ),
                    ),
                    SizedBox(height: 2),
                    Text(
                      'Premium SUV or executive vehicle',
                      style: TextStyle(
                        fontSize: 11.5,
                        color: Colors.grey,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    SizedBox(height: 2),
                    Text(
                      'Professional driver · Upfront fare',
                      style: TextStyle(
                        fontSize: 11,
                        color: Color(0xFF5B7760),
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    'Est. · ~$etaMinutes min',
                    style: TextStyle(
                      fontSize: 10,
                      color: Colors.grey.shade500,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 4),
                  if (fareCents > 0)
                    AnimatedPriceReduction(
                      originalCents: fareCents,
                      finalCents: finalCents,
                      savedCents: savedCents,
                      priceStyle: const TextStyle(
                        fontSize: 19,
                        fontWeight: FontWeight.w800,
                        color: Color(0xFF2F3A32),
                        letterSpacing: -0.5,
                      ),
                    )
                  else
                    const Text(
                      '—',
                      style: TextStyle(
                        fontSize: 19,
                        fontWeight: FontWeight.w800,
                        color: Color(0xFF2F3A32),
                      ),
                    ),
                ],
              ),
            ],
          ),
          if (savedCents > 0) ...[
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerLeft,
              child: SavedBadge(cents: savedCents),
            ),
          ],
          // Price breakdown: discounts then final total. Only shown when
          // something is applied so the card stays quiet for a plain ride.
          if (savedCents > 0) ...[
            const SizedBox(height: 10),
            _priceBreakdownRow(
              label: _promoDiscountCents > 0
                  ? 'Promo ${_promoCodeController.text.trim().toUpperCase()}'
                  : 'Promo',
              amount: -_promoDiscountCents,
              color: const Color(0xFF5B7760),
            ),
            _priceBreakdownRow(
              label: 'Ride credits',
              amount: -_creditsToUseCents,
              color: const Color(0xFF5B7760),
            ),
            const SizedBox(height: 8),
            const Divider(height: 1),
            const SizedBox(height: 8),
            _priceBreakdownRow(
              label: 'You pay',
              amount: finalCents,
              isBold: true,
              priceStyle: const TextStyle(
                fontSize: 17,
                fontWeight: FontWeight.w800,
                color: Color(0xFF2F3A32),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _priceBreakdownRow({
    required String label,
    required int amount,
    bool isBold = false,
    Color? color,
    TextStyle? priceStyle,
  }) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: isBold ? FontWeight.w700 : FontWeight.w500,
                color: color ?? Colors.grey.shade700,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Text(
            amount == 0 ? '' : formatCents(amount),
            style:
                priceStyle ??
                TextStyle(
                  fontSize: 12.5,
                  fontWeight: isBold ? FontWeight.w700 : FontWeight.w500,
                  color: const Color(0xFF2F3A32),
                ),
          ),
        ],
      ),
    );
  }

  /// Explore: current-location card. Tapping lets the rider pick a custom
  /// pickup point; the GPS position remains the default and can always be
  /// restored with the "Use Current Location" affordance.
  Widget _buildExploreLocationCard(ThemeData theme) {
    final isDefaultPickup =
        _pickup == null || _pickup!.address == 'Current Location';
    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(20),
      child: InkWell(
        onTap: () => _openSearch(true),
        borderRadius: BorderRadius.circular(20),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(20),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withOpacity(0.08),
                blurRadius: 20,
                offset: const Offset(0, 10),
              ),
            ],
          ),
          child: Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: const Color(0xFF5B7760).withOpacity(0.12),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(
                  isDefaultPickup
                      ? Icons.my_location_rounded
                      : Icons.location_on_rounded,
                  color: const Color(0xFF5B7760),
                  size: 20,
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      isDefaultPickup ? 'Current location' : 'Pickup',
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.3,
                        color: isDefaultPickup
                            ? const Color(0xFF2F3A32).withOpacity(0.5)
                            : const Color(0xFF5B7760),
                      ),
                    ),
                    const SizedBox(height: 2),
                    AnimatedSwitcher(
                      duration: const Duration(milliseconds: 220),
                      switchInCurve: Curves.easeOut,
                      switchOutCurve: Curves.easeIn,
                      child: Text(
                        _pickup?.address ?? 'Use GPS',
                        key: ValueKey(_pickup?.address ?? 'Use GPS'),
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: Color(0xFF2F3A32),
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              if (isDefaultPickup)
                const Icon(
                  Icons.chevron_right_rounded,
                  color: Color(0xFF2F3A32),
                  size: 20,
                )
              else
                InkWell(
                  onTap: _restoreCurrentLocation,
                  borderRadius: BorderRadius.circular(12),
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 6,
                    ),
                    decoration: BoxDecoration(
                      color: const Color(0xFF5B7760).withOpacity(0.10),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          Icons.my_location_rounded,
                          size: 13,
                          color: Color(0xFF5B7760),
                        ),
                        SizedBox(width: 6),
                        Text(
                          'Use Current Location',
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                            color: Color(0xFF5B7760),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  /// Explore: the "Where to?" card — single destination search entry point.
  /// Shares the exact layout system (padding, icon block, spacing, label +
  /// value hierarchy) of [_buildExploreLocationCard] so the two fields read
  /// as one component.
  Widget _buildWhereToCard(ThemeData theme) {
    final hasDestination = _destination != null;
    final text = _destination?.address ?? 'Where to?';
    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(20),
      child: InkWell(
        onTap: () => _openSearch(false),
        borderRadius: BorderRadius.circular(20),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(20),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withOpacity(0.08),
                blurRadius: 20,
                offset: const Offset(0, 10),
              ),
            ],
          ),
          child: Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: const Color(0xFF5B7760).withOpacity(0.12),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: const Icon(
                  Icons.square_rounded,
                  color: Color(0xFF5B7760),
                  size: 20,
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Destination',
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.3,
                        color: hasDestination
                            ? const Color(0xFF5B7760)
                            : const Color(0xFF2F3A32).withOpacity(0.5),
                      ),
                    ),
                    const SizedBox(height: 2),
                    AnimatedSwitcher(
                      duration: const Duration(milliseconds: 220),
                      switchInCurve: Curves.easeOut,
                      switchOutCurve: Curves.easeIn,
                      child: Text(
                        text,
                        key: ValueKey(text),
                        style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: const Color(
                            0xFF2F3A32,
                          ).withOpacity(hasDestination ? 1.0 : 0.4),
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              const Icon(
                Icons.chevron_right_rounded,
                color: Color(0xFF2F3A32),
                size: 20,
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// Explore: recent destination searches, straight from the single backend
  /// search-history store (same source the search screen reads).
  Widget _buildRecentSearches(ThemeData theme) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Recent',
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w700,
            color: const Color(0xFF2F3A32).withOpacity(0.7),
          ),
        ),
        const SizedBox(height: 8),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              for (final result in _recentSearches)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: Material(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(20),
                    child: InkWell(
                      onTap: () => _applyRecentSearch(result),
                      borderRadius: BorderRadius.circular(20),
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 10,
                        ),
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(20),
                          border: Border.all(color: const Color(0xFFD8D2CA)),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(
                              Icons.history_rounded,
                              size: 16,
                              color: Color(0xFF5B7760),
                            ),
                            const SizedBox(width: 8),
                            ConstrainedBox(
                              constraints: const BoxConstraints(maxWidth: 160),
                              child: Text(
                                result.displayName,
                                style: const TextStyle(
                                  fontSize: 13,
                                  fontWeight: FontWeight.w500,
                                  color: Color(0xFF2F3A32),
                                ),
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildUserLocationMarker() {
    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFF5B7760).withOpacity(0.2),
        shape: BoxShape.circle,
      ),
      child: Center(
        child: Container(
          width: 14,
          height: 14,
          decoration: BoxDecoration(
            color: const Color(0xFF5B7760),
            shape: BoxShape.circle,
            border: Border.all(color: Colors.white, width: 2),
            boxShadow: [
              BoxShadow(blurRadius: 8, color: Colors.black.withOpacity(0.2)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildPinMarker(Color color, {bool isPickup = true}) {
    return Stack(
      alignment: Alignment.center,
      children: [
        Icon(Icons.location_on, color: color, size: 30),
        Positioned(
          top: 6,
          child: Container(
            width: 6,
            height: 6,
            decoration: const BoxDecoration(
              color: Colors.white,
              shape: BoxShape.circle,
            ),
          ),
        ),
      ],
    );
  }

  /// Specials sponsor map pin. Rendered ONLY for sponsors present in the
  /// backend's eligible active-specials list — the same list as the Explore
  /// SPECIALS section, so zero active specials means zero markers.
  ///
  /// The selected business gets a clearly visible RED marker (spec §15);
  /// unselected markers keep the brand green. Movement between selections is
  /// driven entirely by `SpecialsProvider.selectedSpecialId`.
  Widget _buildSponsorMarker(SponsorSpecial s, {required bool selected}) {
    final color = selected ? const Color(0xFFD64545) : const Color(0xFF5B7760);
    final size = selected ? 38.0 : 30.0;
    final marker = Semantics(
      button: true,
      label: 'Special at ${s.businessName}',
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          color: color,
          shape: BoxShape.circle,
          border: Border.all(color: Colors.white, width: selected ? 3 : 2),
          boxShadow: [
            BoxShadow(
              blurRadius: selected ? 12 : 8,
              color: Colors.black.withValues(alpha: selected ? 0.35 : 0.25),
              offset: const Offset(0, 3),
            ),
          ],
        ),
        child: Center(
          child: Icon(
            specialTypeIcon(s.businessType),
            color: Colors.white,
            size: selected ? 19 : 15,
          ),
        ),
      ),
    );
    if (!selected) return marker;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0.72, end: 1.0),
      duration: const Duration(milliseconds: 240),
      curve: Curves.easeOutBack,
      builder: (context, scale, child) =>
          Transform.scale(scale: scale, child: child),
      child: marker,
    );
  }
}
