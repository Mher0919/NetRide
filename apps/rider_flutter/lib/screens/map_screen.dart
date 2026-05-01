import 'package:dio/dio.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:geolocator/geolocator.dart';
import 'package:provider/provider.dart';
import '../providers/ride_provider.dart';
import '../models/trip_models.dart' as models;
import '../services/routing_service.dart';
import '../services/user_service.dart';
import '../services/auth_service.dart';
import 'address_search_delegate.dart';

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
  bool _isLoading = true;
  bool _isMapReady = false;
  bool _shouldFollowUser = true;
  StreamSubscription<Position>? _positionSubscription;
  String _firstName = "";

  @override
  void initState() {
    super.initState();
    _initLiveLocation();
    _fetchProfile();
  }

  Future<void> _fetchProfile() async {
    try {
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
          Navigator.pushNamedAndRemoveUntil(context, '/login', (route) => false);
        }
        return;
      }
      debugPrint('Error fetching profile: $e');
    }
  }

  @override
  void dispose() {
    _positionSubscription?.cancel();
    super.dispose();
  }

  Future<void> _initLiveLocation() async {
    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      setState(() => _isLoading = false);
      return;
    }

    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) {
        setState(() => _isLoading = false);
        return;
      }
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

    setState(() => _isLoading = false);
  }

  void _updateUserLocation(Position position) {
    if (!mounted) return;
    setState(() {
      _userPosition = LatLng(position.latitude, position.longitude);
      _smoothedPosition = LatLng(
        (_smoothedPosition!.latitude * 0.5) + (_userPosition!.latitude * 0.5),
        (_smoothedPosition!.longitude * 0.5) + (_userPosition!.longitude * 0.5),
      );

      if (_pickup == null || _pickup!.address == 'Current Location') {
        _pickup = models.Location(
          lat: position.latitude,
          lng: position.longitude,
          address: 'Current Location',
        );
      }
    });

    if (_shouldFollowUser && _smoothedPosition != null && _isMapReady) {
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        if (mounted && _isMapReady) {
          try {
            // Increased delay and extra check to ensure the map is fully interactive
            await Future.delayed(const Duration(milliseconds: 100));
            if (mounted && _isMapReady) {
              _mapController.move(_smoothedPosition!, 15.0);
            }
          } catch (e) {
            // Silently handle the LateInitializationError as it's a known flutter_map race condition
            if (!e.toString().contains('LateInitializationError')) {
              debugPrint('Map move error: $e');
            }
          }
        }
      });
    }
  }

  void _fetchRoute(LatLng start, LatLng end) async {
    final routeData = await _routingService.getRoute(start, end);
    if (mounted && routeData.isNotEmpty) {
      setState(() {
        _routePoints = routeData['points_list'] as List<LatLng>;
      });
    }
  }

  void _openSearch(bool isPickup) async {
    if (_userPosition == null) return;
    final result = await showSearch<AddressSearchResult?>(
      context: context,
      delegate: AddressSearchDelegate(
        userLat: _userPosition!.latitude,
        userLon: _userPosition!.longitude,
      ),
    );

    if (result != null) {
      setState(() {
        _shouldFollowUser = false;
        final loc = models.Location(
          lat: result.lat,
          lng: result.lon,
          address: result.displayName,
        );
        if (isPickup) {
          _pickup = loc;
          _mapController.move(LatLng(loc.lat, loc.lng), 15.0);
        } else {
          _destination = loc;
          _mapController.move(LatLng(loc.lat, loc.lng), 15.0);
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final rideProvider = Provider.of<RideProvider>(context);
    final theme = Theme.of(context);

    return Scaffold(
      body: Stack(
        children: [
          if (!_isLoading && _smoothedPosition != null)
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
                        0.937, 0, 0, 0, 0, // R
                        0, 0.922, 0, 0, 0, // G
                        0, 0, 0.902, 0, 0, // B
                        0, 0, 0, 1, 0,      // A
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
              ],
            ),
          
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
              child: Column(
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
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
                          _firstName.isNotEmpty ? 'Hello, $_firstName' : 'Welcome',
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
                          BoxShadow(
                            color: Colors.black.withOpacity(0.08),
                            blurRadius: 20,
                            offset: const Offset(0, 10),
                          ),
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

          if (_isLoading)
            const Center(child: CircularProgressIndicator()),

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
                _mapController.move(_smoothedPosition!, 15.0);
              },
              child: const Icon(Icons.my_location),
            ),
          ),

          if (_pickup != null && _destination != null)
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
      behavior: HitTestBehavior.opaque,
      child: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Row(
          children: [
            Icon(icon, size: 10, color: iconColor),
            const SizedBox(width: 16),
            Expanded(
              child: Text(
                text,
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                  color: text.contains('?') || text == 'Where to?' 
                      ? const Color(0xFF2F3A32).withOpacity(0.4) 
                      : const Color(0xFF2F3A32),
                ),
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
      decoration: BoxDecoration(
        color: const Color(0xFF5B7760).withOpacity(0.15),
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
              BoxShadow(
                blurRadius: 8,
                color: const Color(0xFF5B7760).withOpacity(0.3),
              )
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildPinMarker(Color color, {required bool isPickup}) {
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


