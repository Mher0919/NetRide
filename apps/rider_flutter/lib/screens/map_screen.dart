import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:geolocator/geolocator.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../providers/ride_provider.dart';
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
import 'address_search_delegate.dart';
import '../components/state_container.dart';
import '../components/smooth_driver_marker.dart';

class MapScreen extends StatefulWidget {
  const MapScreen({super.key});

  @override
  State<MapScreen> createState() => _MapScreenState();
}

class _MapScreenState extends State<MapScreen> with TickerProviderStateMixin {
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

  // Rewards options at checkout (promo code + ride credits).
  final TextEditingController _promoCodeController = TextEditingController();
  bool _applyCredits = true;
  int? _creditBalanceCents;
  bool _creditBalanceLoaded = false;
  PromoPreview? _promoPreview;
  bool _promoChecking = false;
  bool _promoApplied = false;

  // Explore: recent searches shown under the destination card. The backend
  // search-history store is the single source of truth (same one the
  // address-search delegate reads inside the search screen).
  List<SearchResult> _recentSearches = [];

  @override
  void initState() {
    super.initState();
    _initCacheServices();
    _initLiveLocation();
    _fetchProfile();
    _startGeohashUpdates();
    _loadRecentSearches();
  }

  Future<void> _loadRecentSearches() async {
    final recent = await SearchHistoryService.instance.fetch();
    if (!mounted) return;
    setState(() => _recentSearches = recent.take(6).toList());
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
  void dispose() {
    _positionSubscription?.cancel();
    _geohashTimer?.cancel();
    _promoCodeController.dispose();
    super.dispose();
  }

  Future<void> _initLiveLocation() async {
    setState(() => _state = ViewState.loading);
    try {
      bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) {
        setState(() {
          _state = ViewState.failure;
          _errorMessage =
              'Location services are disabled. Please enable them in your settings.';
        });
        return;
      }

      LocationPermission permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
        if (permission == LocationPermission.denied) {
          setState(() {
            _state = ViewState.failure;
            _errorMessage = 'Location permissions are required to use NetRide.';
          });
          return;
        }
      }

      if (permission == LocationPermission.deniedForever) {
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

      _userPosition = LatLng(position.latitude, position.longitude);
      _smoothedPosition = _userPosition;
      _updateUserLocation(position);

      _positionSubscription =
          Geolocator.getPositionStream(
            locationSettings: const LocationSettings(
              accuracy: LocationAccuracy.bestForNavigation,
              distanceFilter: 0,
            ),
          ).listen((position) {
            _updateUserLocation(position);
          });

      setState(() => _state = ViewState.success);
    } catch (e) {
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
        }
      });
      _updateRoute();
      // The search screen saved this pick; keep Explore's recent list fresh.
      _loadRecentSearches();
    }
  }

  void _updateRoute() async {
    if (_pickup == null || _destination == null) return;

    try {
      final plan = await _routingService.plan(
        origin: LatLng(_pickup!.lat, _pickup!.lng),
        destination: LatLng(_destination!.lat, _destination!.lng),
      );

      if (mounted) {
        setState(() {
          _routePoints = plan.points;
        });

        final bounds = LatLngBounds.fromPoints([
          LatLng(_pickup!.lat, _pickup!.lng),
          LatLng(_destination!.lat, _destination!.lng),
          ..._routePoints,
        ]);
        _mapController.fitCamera(
          CameraFit.bounds(bounds: bounds, padding: const EdgeInsets.all(50)),
        );
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

  /// Platform fare estimate. The backend computes the exact quote with the
  /// same formula used for the ride's price snapshot, so the panel price is
  /// what the rider will be charged.
  static double _computeFare({
    required double distanceMeters,
    required double durationSeconds,
  }) {
    const base = 3.50,
        perKm = 1.50,
        perMin = 0.35,
        booking = 1.50,
        minFare = 7.00;
    const serviceRate = 0.10, taxRate = 0.0875;
    final distanceKm = distanceMeters / 1000.0;
    final minutes = durationSeconds / 60.0;
    final subtotal = base + distanceKm * perKm + minutes * perMin + booking;
    final service = subtotal * serviceRate;
    final taxable = subtotal + service;
    final taxes = taxable * taxRate;
    final raw = taxable + taxes;
    return ((raw * 100).roundToDouble() / 100).clamp(
      minFare,
      double.infinity,
    );
  }

  /// Pulls the ride estimate (route geometry + platform fare).
  /// Checks the ETA cache first; makes ONE backend call for route data.
  /// Writes to cache on success.
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
      _buildEstimateFromRouteData(
        distanceMeters: cachedEta.distanceMeters,
        durationSeconds: cachedEta.durationSeconds,
        engine: 'EtaCache',
      );
      if (mounted) {
        setState(() => _loadingEstimates = false);
      }
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
        backendFareTotal:
            (plan.fare['totalFare'] as num?)?.toDouble() ?? 0.0,
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

  void _buildEstimateFromRouteData({
    required double distanceMeters,
    required double durationSeconds,
    double backendFareTotal = 0.0,
    required String engine,
  }) {
    _estimateDurationSeconds = durationSeconds;
    _estimateFare = backendFareTotal > 0
        ? backendFareTotal
        : _computeFare(
            distanceMeters: distanceMeters,
            durationSeconds: durationSeconds,
          );
  }

  void _confirmRide() {
    if (_pickup == null || _destination == null) return;
    setState(() => _requesting = true);
    Provider.of<RideProvider>(
      context,
      listen: false,
    ).requestRide(
      _pickup!,
      _destination!,
      promoCode: _promoApplied ? _promoCodeController.text : null,
      applyCredits: _applyCredits,
    );
  }

  void _closePanel() {
    if (_requesting) {
      Provider.of<RideProvider>(context, listen: false).cancelRide();
    }
    setState(() {
      _panelOpen = false;
      _requesting = false;
      _destination = null;
      _routePoints = [];
      _shouldFollowUser = true;
      _hasNavigatedToTrip = false;
      _promoCodeController.clear();
      _promoPreview = null;
      _promoApplied = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final rideProvider = Provider.of<RideProvider>(context);
    final theme = Theme.of(context);

    // When a driver accepts, leave the map and go to the active trip screen.
    if (rideProvider.status == models.TripStatus.ACCEPTED &&
        !_hasNavigatedToTrip &&
        _requesting) {
      _hasNavigatedToTrip = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) Navigator.pushReplacementNamed(context, '/trip');
      });
    }

    return Scaffold(
      body: StateContainer(
        state: _state,
        errorMessage: _errorMessage,
        onRetry: _initLiveLocation,
        successWidget: Stack(
          children: [
            Column(
              children: [
                SafeArea(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 20,
                      vertical: 10,
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 16,
                                vertical: 8,
                              ),
                              decoration: BoxDecoration(
                                color: Colors.white,
                                borderRadius: BorderRadius.circular(24),
                                boxShadow: [
                                  BoxShadow(
                                    color: Colors.black.withOpacity(0.05),
                                    blurRadius: 10,
                                    offset: const Offset(0, 4),
                                  ),
                                ],
                              ),
                              child: Text(
                                _firstName.isNotEmpty
                                    ? 'Hello, $_firstName'
                                    : 'Welcome',
                                style: theme.textTheme.bodyMedium?.copyWith(
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
                                border: Border.all(color: Colors.white, width: 2),
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
                        if (_recentSearches.isNotEmpty) ...[
                          const SizedBox(height: 14),
                          _buildRecentSearches(theme),
                        ],
                      ],
                    ),
                  ),
                ),
                if (_smoothedPosition != null)
                  Expanded(
                    child: ClipRRect(
                      borderRadius: const BorderRadius.vertical(
                        top: Radius.circular(24),
                      ),
                      child: FlutterMap(
                        mapController: _mapController,
                        options: MapOptions(
                          initialCenter: _smoothedPosition!,
                          initialZoom: 15.0,
                          minZoom: 12,
                          maxZoom: 18,
                          onMapReady: () {
                            setState(() => _isMapReady = true);
                          },
                          onPositionChanged: (pos, hasGesture) {
                            if (hasGesture) {
                              setState(() => _shouldFollowUser = false);
                            }
                          },
                        ),
                        children: [
                          TileLayer(
                            urlTemplate:
                                'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
                            subdomains: const ['a', 'b', 'c', 'd'],
                            userAgentPackageName: 'com.NetRide.rider',
                            tileBuilder: (context, tileWidget, tile) {
                              return ColorFiltered(
                                colorFilter: const ColorFilter.matrix(<double>[
                                  0.937,
                                  0,
                                  0,
                                  0,
                                  0,
                                  0,
                                  0.922,
                                  0,
                                  0,
                                  0,
                                  0,
                                  0,
                                  0.902,
                                  0,
                                  0,
                                  0,
                                  0,
                                  0,
                                  1,
                                  0,
                                ]),
                                child: ColorFiltered(
                                  colorFilter: ColorFilter.mode(
                                    const Color(0xFFEEEBE6).withOpacity(0.3),
                                    BlendMode.multiply,
                                  ),
                                  child: tileWidget,
                                ),
                              );
                            },
                          ),
                          if (_routePoints.isNotEmpty)
                            PolylineLayer(
                              polylines: [
                                Polyline<Object>(
                                  points: _routePoints,
                                  color: const Color(0xFF5B7760),
                                  strokeWidth: 4.0,
                                  borderColor: Colors.white,
                                  borderStrokeWidth: 1.0,
                                ),
                              ],
                            ),
                          MarkerLayer(
                            markers: [
                              if (_smoothedPosition != null)
                                Marker(
                                  point: _smoothedPosition!,
                                  width: 40,
                                  height: 40,
                                  child: _buildUserLocationMarker(),
                                ),
                              if (_pickup != null &&
                                  _pickup!.address != 'Current Location')
                                Marker(
                                  point: LatLng(_pickup!.lat, _pickup!.lng),
                                  width: 30,
                                  height: 30,
                                  child: _buildPinMarker(
                                    const Color(0xFF5B7760),
                                    isPickup: true,
                                  ),
                                ),
                              if (_destination != null)
                                Marker(
                                  point:
                                      LatLng(_destination!.lat, _destination!.lng),
                                  width: 30,
                                  height: 30,
                                  child: _buildPinMarker(
                                    const Color(0xFF2F3A32),
                                    isPickup: false,
                                  ),
                                ),
                            ],
                          ),
                          for (var entry in rideProvider.nearbyDrivers.entries)
                            SmoothDriverMarker(
                              driverId: entry.key,
                              position:
                                  LatLng(entry.value.lat, entry.value.lng),
                              heading: 0,
                            ),
                        ],
                      ),
                    ),
                  )
                else
                  const Expanded(child: SizedBox()),
              ],
            ),

            Positioned(
              right: 20,
              bottom: (_pickup != null && _destination != null) ? 140 : 40,
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
            ),

            if (_panelOpen && _pickup != null && _destination != null)
              _buildRidePanel(theme)
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
        ),
      ),
    );
  }

  Widget _buildRidePanel(ThemeData theme) {
    final rideProvider = Provider.of<RideProvider>(context);
    final searching =
        _requesting && rideProvider.status == models.TripStatus.REQUESTED;

    return Positioned(
      bottom: 0,
      left: 0,
      right: 0,
      child: Container(
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withOpacity(0.12),
              blurRadius: 24,
              offset: const Offset(0, -8),
            ),
          ],
        ),
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
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
                IconButton(
                  icon: const Icon(
                    Icons.close,
                    size: 20,
                    color: Color(0xFF2F3A32),
                  ),
                  onPressed: _closePanel,
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(),
                ),
              ],
            ),
            const SizedBox(height: 14),
            if (_loadingEstimates)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: CircularProgressIndicator(color: Color(0xFF5B7760)),
              )
            else if (searching)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 28),
                child: Column(
                  children: [
                    SizedBox(
                      width: 36,
                      height: 36,
                      child: CircularProgressIndicator(
                        strokeWidth: 3,
                        color: Color(0xFF5B7760),
                      ),
                    ),
                    SizedBox(height: 16),
                    Text(
                      'Matching you with nearby drivers…',
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
                        color: Color(0xFF2F3A32),
                      ),
                    ),
                  ],
                ),
              )
            else
              Column(
                children: [
                  _buildRideCard(theme),
                  _buildRewardsPanel(theme),
                  const SizedBox(height: 16),
                  SizedBox(
                    width: double.infinity,
                    height: 54,
                    child: ElevatedButton(
                      onPressed: _confirmRide,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF2F3A32),
                        foregroundColor: Colors.white,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(14),
                        ),
                      ),
                      child: const Text(
                        'Confirm NetRide Premium',
                        style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 0.5,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }

  /// Lazy-loads the rider's credit balance once per session.
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
      setState(() => _creditBalanceLoaded = true);
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

  /// Compact promo + credits options shown at checkout.
  Widget _buildRewardsPanel(ThemeData theme) {
    if (!_creditBalanceLoaded) _loadRewardsOptions();

    final balanceCents = _creditBalanceCents ?? 0;
    final balanceLabel = balanceCents > 0 ? formatCents(balanceCents) : null;

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFD8D2CA)),
      ),
      child: Column(
        children: [
          Row(
            children: [
              const Icon(Icons.local_offer_outlined, size: 18, color: Color(0xFF5B7760)),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _promoCodeController,
                  textCapitalization: TextCapitalization.characters,
                  decoration: const InputDecoration(
                    hintText: 'Promo code',
                    isDense: true,
                    border: InputBorder.none,
                  ),
                  style: const TextStyle(fontSize: 14, color: Color(0xFF2F3A32)),
                  onSubmitted: (_) => _validatePromo(),
                ),
              ),
              if (_promoChecking)
                const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF5B7760)),
                )
              else if (_promoApplied)
                const Icon(Icons.check_circle_rounded, color: Color(0xFF6E8B74), size: 20)
              else
                TextButton(
                  onPressed: _validatePromo,
                  child: const Text('Apply'),
                ),
            ],
          ),
          if (_promoPreview != null && _promoCodeController.text.trim().isNotEmpty) ...[
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  _promoPreview!.valid
                      ? '${_promoPreview!.discountLabel ?? 'Discount'} applied'
                      : _promoPreview!.reason ?? 'Promo not available',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: _promoPreview!.valid ? const Color(0xFF6E8B74) : const Color(0xFFC65A5A),
                  ),
                ),
              ),
            ),
          ],
          const Divider(height: 1),
          Row(
            children: [
              const Icon(Icons.account_balance_wallet_outlined, size: 18, color: Color(0xFF5B7760)),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  balanceLabel != null
                      ? 'Use ride credits ($balanceLabel available)'
                      : 'Use ride credits',
                  style: const TextStyle(fontSize: 13, color: Color(0xFF2F3A32)),
                ),
              ),
              Switch(
                value: _applyCredits,
                activeTrackColor: const Color(0xFF5B7760),
                onChanged: (v) => setState(() => _applyCredits = v),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildRideCard(ThemeData theme) {
    final price = _estimateFare;
    final etaMinutes = (_estimateDurationSeconds / 60).round().clamp(1, 99);

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: const Color(0xFF5B7760).withOpacity(0.08),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF5B7760), width: 2),
      ),
      child: Row(
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: const Color(0xFF5B7760),
              borderRadius: BorderRadius.circular(12),
            ),
            child: const Icon(
              Icons.airport_shuttle_outlined,
              color: Colors.white,
              size: 26,
            ),
          ),
          const SizedBox(width: 14),
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
              Text(
                price > 0 ? '\$${price.toStringAsFixed(2)}' : '—',
                style: const TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w800,
                  color: Color(0xFF2F3A32),
                  letterSpacing: -0.5,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildSearchField({
    required VoidCallback onTap,
    required String text,
    required IconData icon,
    required Color iconColor,
    required bool isFirst,
  }) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
        child: Row(
          children: [
            Icon(icon, size: 14, color: iconColor),
            const SizedBox(width: 16),
            Expanded(
              child: Text(
                text,
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: isFirst ? FontWeight.w500 : FontWeight.w600,
                  color: const Color(
                    0xFF2F3A32,
                  ).withOpacity(text == 'Where to?' ? 0.4 : 1.0),
                ),
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Explore: current-location card. Tapping lets the rider pick a custom
  /// pickup point; the GPS position remains the default.
  Widget _buildExploreLocationCard(ThemeData theme) {
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
                child: const Icon(
                  Icons.my_location_rounded,
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
                      'Current location',
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.3,
                        color: const Color(0xFF2F3A32).withOpacity(0.5),
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      _pickup?.address ?? 'Use GPS',
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        color: Color(0xFF2F3A32),
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
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

  /// Explore: the "Where to?" card — single destination search entry point.
  Widget _buildWhereToCard(ThemeData theme) {
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.08),
            blurRadius: 20,
            offset: const Offset(0, 10),
          ),
        ],
      ),
      child: _buildSearchField(
        onTap: () => _openSearch(false),
        text: _destination?.address ?? 'Where to?',
        icon: Icons.square,
        iconColor: const Color(0xFF2F3A32),
        isFirst: false,
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
}
