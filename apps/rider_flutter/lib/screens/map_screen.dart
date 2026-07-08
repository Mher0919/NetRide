import 'package:dio/dio.dart';
import 'dart:async';
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
  Timer? _debounceTimer;
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

  @override
  void initState() {
    super.initState();
    _initLiveLocation();
    _fetchProfile();
    _startGeohashUpdates();
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
    _debounceTimer?.cancel();
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
    final result = await showSearch<AddressSearchResult?>(
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
      final route = await _routingService.getRoute(
        LatLng(_pickup!.lat, _pickup!.lng),
        LatLng(_destination!.lat, _destination!.lng),
      );

      if (mounted) {
        setState(() {
          _routePoints = route['points_list'] as List<LatLng>;
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
  }

  @override
  Widget build(BuildContext context) {
    final rideProvider = Provider.of<RideProvider>(context);
    final theme = Theme.of(context);

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

            if (_pickup != null && _destination != null && _verificationStatus != 'PENDING')
              Positioned(
                bottom: 40,
                left: 20,
                right: 20,
                child: Hero(
                  tag: 'confirm_button',
                  child: SizedBox(
                    width: double.infinity,
                    child: ElevatedButton(
                      onPressed: () {
                        Navigator.pushNamed(
                          context,
                          '/ride_request',
                          arguments: {'pickup': _pickup, 'destination': _destination},
                        );
                      },
                      child: const Text('Confirm NetRide'),
                    ),
                  ),
                ),
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
