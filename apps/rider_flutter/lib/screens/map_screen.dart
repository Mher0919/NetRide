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
import '../services/api_service.dart';
import '../services/route_cache_service.dart';
import '../services/eta_cache_service.dart';
import '../models/search_result.dart';
import 'address_search_delegate.dart';
import '../components/state_container.dart';
import '../components/smooth_driver_marker.dart';
import '../components/verification_banner.dart';

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
  String _verificationStatus = "VERIFIED";
  String? _rejectionReason;
  bool _feedbackSeen = true;

  // Ride-selection panel state (kept on the map, never navigates away).
  bool _panelOpen = false;
  bool _loadingEstimates = false;
  bool _requesting = false;
  models.VehicleClass _selectedClass = models.VehicleClass.CORE;
  Map<models.VehicleClass, Map<String, dynamic>> _estimates = {};
  bool _hasNavigatedToTrip = false;

  @override
  void initState() {
    super.initState();
    _initCacheServices();
    _initLiveLocation();
    _fetchProfile();
    _startGeohashUpdates();
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
        Provider.of<RideProvider>(context, listen: false).subscribeToNearbyDrivers(
          models.Location(lat: _userPosition!.latitude, lng: _userPosition!.longitude)
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
          _verificationStatus = profile['verification_status'] ?? "VERIFIED";
          _rejectionReason = profile['rejection_reason'];
          _feedbackSeen = profile['verification_feedback_seen'] == true;
        });
      }
    } catch (e) {
      if (e is DioException && e.response?.statusCode == 404) {
        debugPrint('User not found (404), logging out...');
        await AuthService.logout();
        if (mounted) {
          Navigator.pushNamedAndRemoveUntil(context, '/login', (route) => false);
        }
        return;
      }
      debugPrint('Error fetching profile: $e');
    }
  }

  Future<void> _dismissFeedback() async {
    try {
      await ApiService.dio.patch('/ride/verification/dismiss');
      setState(() => _feedbackSeen = true);
    } catch (e) {
      debugPrint('Error dismissing feedback: $e');
    }
  }

  void _showRejectionDetails() {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: const Text('Rejection Feedback', style: TextStyle(fontWeight: FontWeight.bold)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Administrative feedback on your application:', style: TextStyle(fontSize: 13, color: Colors.grey)),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(color: Colors.red.withOpacity(0.05), borderRadius: BorderRadius.circular(12), border: Border.all(color: Colors.red.withOpacity(0.1))),
              child: Text(
                _rejectionReason ?? 'No specific reason provided. Please contact support.',
                style: const TextStyle(fontWeight: FontWeight.w600, height: 1.5),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('DISMISS')),
          ElevatedButton(
            onPressed: () {
              Navigator.pop(context);
              // Navigation to verification could go here
            },
            style: ElevatedButton.styleFrom(backgroundColor: Colors.black, foregroundColor: Colors.white),
            child: const Text('UPDATE ID PHOTOS'),
          ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    _positionSubscription?.cancel();
    _geohashTimer?.cancel();
    super.dispose();
  }

  Future<void> _initLiveLocation() async {
    setState(() => _state = ViewState.loading);
    try {
      bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) {
        setState(() {
          _state = ViewState.failure;
          _errorMessage = 'Location services are disabled. Please enable them in your settings.';
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
          _errorMessage = 'Location permissions are permanently denied. Please enable them in system settings.';
        });
        return;
      }

      final position = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.bestForNavigation,
      );
      
      _userPosition = LatLng(position.latitude, position.longitude);
      _smoothedPosition = _userPosition;
      _updateUserLocation(position);

      _positionSubscription = Geolocator.getPositionStream(
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
        _errorMessage = 'An error occurred while initializing location tracking.';
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
        final loc = models.Location(lat: result.lat, lng: result.lon, address: result.displayName);
        if (isPickup) {
          _pickup = loc;
        } else {
          _destination = loc;
          _shouldFollowUser = false;
        }
      });
      _updateRoute();
    }
  }

  void _updateRoute() async {
    if (_pickup == null || _destination == null) return;

    try {
      final plan = await _routingService.plan(
        origin: LatLng(_pickup!.lat, _pickup!.lng),
        destination: LatLng(_destination!.lat, _destination!.lng),
        vehicleClass: _selectedClass.toString().split('.').last,
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
        _mapController.fitCamera(CameraFit.bounds(bounds: bounds, padding: const EdgeInsets.all(50)));
      }
    } catch (e) {
      debugPrint('Route error: $e');
    }

    // Once both endpoints exist, open the in-map ride-selection panel and
    // fetch the ride options for every class in a single batch call.
    if (_pickup != null && _destination != null && !_panelOpen) {
      _openRidePanel();
    }
  }

  Future<void> _openRidePanel() async {
    if (_verificationStatus == 'PENDING') return;
    setState(() {
      _panelOpen = true;
      _loadingEstimates = true;
      _estimates = {};
      _selectedClass = models.VehicleClass.CORE;
    });
    await _fetchAllEstimates();
  }

  /// Backend-matching fare formula with class multiplier.
  static double _computeClassFare({
    required double distanceMeters,
    required double durationSeconds,
    required models.VehicleClass vehicleClass,
  }) {
    const base = 3.50, perKm = 1.50, perMin = 0.35, booking = 1.50, minFare = 7.00;
    const serviceRate = 0.10, taxRate = 0.0875;
    final multiplier = _classMultiplier(vehicleClass);
    final distanceKm = distanceMeters / 1000.0;
    final minutes = durationSeconds / 60.0;
    final subtotal = (base + distanceKm * perKm + minutes * perMin) * multiplier + booking;
    final service = subtotal * serviceRate;
    final taxable = subtotal + service;
    final taxes = taxable * taxRate;
    final raw = taxable + taxes;
    return ((raw * 100).roundToDouble() / 100).clamp(minFare * multiplier, double.infinity);
  }

  static double _classMultiplier(models.VehicleClass c) {
    switch (c) {
      case models.VehicleClass.ELITE: return 1.6;
      case models.VehicleClass.PRESTIGE: return 2.4;
      default: return 1.0;
    }
  }

  /// Pull a full ride-option set (route geometry + fare per class).
  /// Checks ETA cache first; makes ONE backend call for route data;
  /// computes per-class fares locally. Writes to cache on success.
  Future<void> _fetchAllEstimates() async {
    if (_pickup == null || _destination == null) return;
    setState(() => _loadingEstimates = true);
    const classes = models.VehicleClass.values;
    final results = <models.VehicleClass, Map<String, dynamic>>{};

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
      _buildEstimatesFromRouteData(
        results,
        classes,
        distanceMeters: cachedEta.distanceMeters,
        durationSeconds: cachedEta.durationSeconds,
        etaSeconds: cachedEta.trafficDurationSeconds ?? cachedEta.durationSeconds,
        engine: 'EtaCache',
      );
      if (mounted) {
        setState(() {
          _estimates = results;
          _loadingEstimates = false;
        });
      }
      return;
    }

    try {
      final plan = await _routingService.plan(
        origin: LatLng(originLat, originLng),
        destination: LatLng(destLat, destLng),
        vehicleClass: 'CORE',
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

      _buildEstimatesFromRouteData(
        results,
        classes,
        distanceMeters: plan.distanceMeters,
        durationSeconds: plan.durationSeconds,
        etaSeconds: plan.etaSeconds,
        engine: plan.engine,
      );

      if (mounted) {
        setState(() {
          _routePoints = plan.points;
          _estimates = results;
          _loadingEstimates = false;
        });
      }
    } catch (e) {
      if (e is DioException && e.type == DioExceptionType.cancel) return;
      debugPrint('Estimate error: $e');
      for (final c in classes) {
        results[c] = {'maxFare': 0.0, 'savingLikelihood': 0, 'distanceKm': 0.0};
      }
      if (mounted) {
        setState(() {
          _estimates = results;
          _loadingEstimates = false;
        });
      }
    }
  }

  void _buildEstimatesFromRouteData(
    Map<models.VehicleClass, Map<String, dynamic>> results,
    List<models.VehicleClass> classes, {
    required double distanceMeters,
    required double durationSeconds,
    required double etaSeconds,
    required String engine,
  }) {
    for (final c in classes) {
      results[c] = {
        'maxFare': _computeClassFare(
          distanceMeters: distanceMeters,
          durationSeconds: durationSeconds,
          vehicleClass: c,
        ),
        'savingLikelihood': 0,
        'distanceKm': distanceMeters / 1000.0,
        'engine': engine,
        'etaSeconds': etaSeconds,
      };
    }
  }

  void _confirmRide() {
    if (_pickup == null || _destination == null) return;
    setState(() => _requesting = true);
    Provider.of<RideProvider>(context, listen: false).requestRide(
      _pickup!,
      _destination!,
      requestedClass: _selectedClass,
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
    });
  }

  @override
  Widget build(BuildContext context) {
    final rideProvider = Provider.of<RideProvider>(context);
    final theme = Theme.of(context);

    // When a driver accepts, leave the map and go to the active trip screen.
    if (rideProvider.status == models.TripStatus.ACCEPTED && !_hasNavigatedToTrip && _requesting) {
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
            if (_smoothedPosition != null)
              FlutterMap(
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
                    urlTemplate: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
                    subdomains: const ['a', 'b', 'c', 'd'],
                    userAgentPackageName: 'com.NetRide.rider',
                    tileBuilder: (context, tileWidget, tile) {
                      return ColorFiltered(
                        colorFilter: const ColorFilter.matrix(<double>[
                          0.937, 0, 0, 0, 0, 0, 0.922, 0, 0, 0, 0, 0, 0.902, 0, 0, 0, 0, 0, 1, 0,
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
                      if (_pickup != null && _pickup!.address != 'Current Location')
                        Marker(
                          point: LatLng(_pickup!.lat, _pickup!.lng),
                          width: 30,
                          height: 30,
                          child: _buildPinMarker(const Color(0xFF5B7760), isPickup: true),
                        ),
                      if (_destination != null)
                        Marker(
                          point: LatLng(_destination!.lat, _destination!.lng),
                          width: 30,
                          height: 30,
                          child: _buildPinMarker(const Color(0xFF2F3A32), isPickup: false),
                        ),
                    ],
                  ),
                  for (var entry in rideProvider.nearbyDrivers.entries)
                    SmoothDriverMarker(
                      driverId: entry.key,
                      position: LatLng(entry.value.lat, entry.value.lng),
                      heading: 0,
                    ),
                ],
              ),
            
            SafeArea(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
                child: Column(
                  children: [
                    if (!_feedbackSeen || _verificationStatus == 'PENDING')
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: VerificationBanner(
                          status: _verificationStatus,
                          reason: _rejectionReason,
                          onDismiss: _dismissFeedback,
                          onViewDetails: _showRejectionDetails,
                        ),
                      ),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                          decoration: BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.circular(24),
                            boxShadow: [
                              BoxShadow(color: Colors.black.withOpacity(0.05), blurRadius: 10, offset: const Offset(0, 4)),
                            ],
                          ),
                          child: Text(
                            _firstName.isNotEmpty ? 'Hello, $_firstName' : 'Welcome',
                            style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600, color: const Color(0xFF2F3A32)),
                          ),
                        ),
                        Container(
                          width: 12,
                          height: 12,
                          decoration: BoxDecoration(
                            color: rideProvider.isConnected ? const Color(0xFF6E8B74) : const Color(0xFFC65A5A),
                            shape: BoxShape.circle,
                            border: Border.all(color: Colors.white, width: 2),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    Hero(
                      tag: 'search_container',
                      child: Container(
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(20),
                          boxShadow: [
                            BoxShadow(color: Colors.black.withOpacity(0.08), blurRadius: 20, offset: const Offset(0, 10)),
                          ],
                        ),
                        child: Column(
                          children: [
                            _buildSearchField(
                              onTap: () => _openSearch(true),
                              text: _pickup?.address ?? 'Current Location',
                              icon: Icons.circle,
                              iconColor: const Color(0xFF5B7760),
                              isFirst: true,
                            ),
                            const Divider(height: 1, indent: 50, endIndent: 20),
                            _buildSearchField(
                              onTap: () => _openSearch(false),
                              text: _destination?.address ?? 'Where to?',
                              icon: Icons.square,
                              iconColor: const Color(0xFF2F3A32),
                              isFirst: false,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
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
            else if (_pickup != null && _destination != null && _verificationStatus != 'PENDING')
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
    final classes = models.VehicleClass.values;
    final rideProvider = Provider.of<RideProvider>(context);
    final searching = _requesting && rideProvider.status == models.TripStatus.REQUESTED;

    return Positioned(
      bottom: 0,
      left: 0,
      right: 0,
      child: Container(
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
          boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.12), blurRadius: 24, offset: const Offset(0, -8))],
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
                    style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800, color: const Color(0xFF2F3A32)),
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.close, size: 20, color: Color(0xFF2F3A32)),
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
                    SizedBox(width: 36, height: 36, child: CircularProgressIndicator(strokeWidth: 3, color: Color(0xFF5B7760))),
                    SizedBox(height: 16),
                    Text('Matching you with nearby drivers…', style: TextStyle(fontWeight: FontWeight.w600, color: Color(0xFF2F3A32))),
                  ],
                ),
              )
            else
              Column(
                children: [
                  ...classes.map((c) => _buildRideCard(c, theme)).toList(),
                  const SizedBox(height: 16),
                  SizedBox(
                    width: double.infinity,
                    height: 54,
                    child: ElevatedButton(
                      onPressed: _confirmRide,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF2F3A32),
                        foregroundColor: Colors.white,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                      ),
                      child: Text(
                        'Confirm NetRide ${_selectedClass.toString().split('.').last}',
                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800, letterSpacing: 0.5),
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

  Widget _buildRideCard(models.VehicleClass c, ThemeData theme) {
    final est = _estimates[c] ?? {'maxFare': 0.0, 'savingLikelihood': 0};
    final isSelected = _selectedClass == c;
    final name = c.toString().split('.').last;
    final IconData icon = c == models.VehicleClass.ELITE
        ? Icons.stars_rounded
        : c == models.VehicleClass.PRESTIGE
            ? Icons.workspace_premium_rounded
            : Icons.directions_car_filled_outlined;
    final price = (est['maxFare'] as num?)?.toDouble() ?? 0.0;
    final saving = (est['savingLikelihood'] as num?)?.toInt() ?? 0;

    return GestureDetector(
      onTap: () => setState(() => _selectedClass = c),
      child: Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(
          color: isSelected ? const Color(0xFF5B7760).withOpacity(0.08) : Colors.white,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: isSelected ? const Color(0xFF5B7760) : const Color(0xFFD8D2CA),
            width: isSelected ? 2 : 1,
          ),
        ),
        child: Row(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: isSelected ? const Color(0xFF5B7760) : const Color(0xFF5B7760).withOpacity(0.1),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(icon, color: isSelected ? Colors.white : const Color(0xFF5B7760), size: 24),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'NetRide $name',
                    style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15, color: Color(0xFF2F3A32)),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    saving > 0 ? 'You\'re $saving% likely to pay less' : 'Based on nearby drivers',
                    style: TextStyle(fontSize: 11.5, color: Colors.grey.shade600, fontWeight: FontWeight.w500),
                  ),
                ],
              ),
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text('Max', style: TextStyle(fontSize: 10, color: Colors.grey.shade500, fontWeight: FontWeight.w600)),
                Text(
                  '\$${price.toStringAsFixed(2)}',
                  style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: Color(0xFF2F3A32), letterSpacing: -0.5),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSearchField({required VoidCallback onTap, required String text, required IconData icon, required Color iconColor, required bool isFirst}) {
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
                style: TextStyle(fontSize: 15, fontWeight: isFirst ? FontWeight.w500 : FontWeight.w600, color: const Color(0xFF2F3A32).withOpacity(text == 'Where to?' ? 0.4 : 1.0)),
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildUserLocationMarker() {
    return Container(
      decoration: BoxDecoration(color: const Color(0xFF5B7760).withOpacity(0.2), shape: BoxShape.circle),
      child: Center(
        child: Container(
          width: 14, height: 14,
          decoration: BoxDecoration(color: const Color(0xFF5B7760), shape: BoxShape.circle, border: Border.all(color: Colors.white, width: 2), boxShadow: [BoxShadow(blurRadius: 8, color: Colors.black.withOpacity(0.2))]),
        ),
      ),
    );
  }

  Widget _buildPinMarker(Color color, {bool isPickup = true}) {
    return Stack(
      alignment: Alignment.center,
      children: [
        Icon(Icons.location_on, color: color, size: 30),
        Positioned(top: 6, child: Container(width: 6, height: 6, decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle))),
      ],
    );
  }
}
