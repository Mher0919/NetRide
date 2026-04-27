import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:geolocator/geolocator.dart';
import 'package:provider/provider.dart';
import '../providers/ride_provider.dart';
import '../models/trip_models.dart' as models;
import '../services/routing_service.dart';
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

  @override
  void initState() {
    super.initState();
    _initLiveLocation();
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
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _isMapReady) {
          _mapController.move(_smoothedPosition!, 15.0);
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

    return Scaffold(
      backgroundColor: const Color(0xFF3D3D3D),
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
                  urlTemplate: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
                  subdomains: const ['a', 'b', 'c', 'd'],
                  userAgentPackageName: 'com.uberish.rider',
                  tileBuilder: (context, tileWidget, tile) {
                    return ColorFiltered(
                      colorFilter: ColorFilter.mode(
                        Colors.black.withOpacity(0.1),
                        BlendMode.darken,
                      ),
                      child: tileWidget,
                    );
                  },
                ),
                if (_routePoints.isNotEmpty)
                  PolylineLayer(
                    polylines: [
                      Polyline(
                        points: _routePoints,
                        color: Colors.blueAccent,
                        strokeWidth: 5.0,
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
                        width: 60,
                        height: 60,
                        child: Container(
                          decoration: BoxDecoration(
                            color: Colors.blue.withOpacity(0.15),
                            shape: BoxShape.circle,
                          ),
                          child: Center(
                            child: Container(
                              width: 14,
                              height: 14,
                              decoration: BoxDecoration(
                                color: Colors.blue,
                                shape: BoxShape.circle,
                                border: Border.all(color: Colors.white, width: 2),
                                boxShadow: [BoxShadow(blurRadius: 10, color: Colors.blue.withOpacity(0.5))],
                              ),
                            ),
                          ),
                        ),
                      ),
                    if (_pickup != null && _pickup!.address != 'Current Location')
                      Marker(
                        point: LatLng(_pickup!.lat, _pickup!.lng),
                        width: 40,
                        height: 40,
                        child: const Icon(Icons.location_on, color: Colors.white, size: 30),
                      ),
                    if (_destination != null)
                      Marker(
                        point: LatLng(_destination!.lat, _destination!.lng),
                        width: 40,
                        height: 40,
                        child: const Icon(Icons.square, color: Colors.white, size: 20),
                      ),
                  ],
                ),
              ],
            ),
          
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 10),
              child: Column(
                children: [
                  AnimatedOpacity(
                    opacity: 1.0,
                    duration: const Duration(milliseconds: 500),
                    child: Row(
                      children: [
                        const Expanded(
                          child: Center(
                            child: Text(
                              'Uberish',
                              style: TextStyle(fontSize: 26, fontWeight: FontWeight.w900, color: Colors.white, letterSpacing: -1),
                            ),
                          ),
                        ),
                        Container(
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(
                            color: rideProvider.isConnected ? Colors.greenAccent : Colors.redAccent,
                            shape: BoxShape.circle,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 20),
                  Hero(
                    tag: 'pickup_search',
                    child: Material(
                      color: Colors.transparent,
                      child: GestureDetector(
                        onTap: () => _openSearch(true),
                        child: _buildSearchBox(_pickup?.address ?? 'Enter pickup location', false),
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Hero(
                    tag: 'destination_search',
                    child: Material(
                      color: Colors.transparent,
                      child: GestureDetector(
                        onTap: () => _openSearch(false),
                        child: _buildSearchBox(_destination?.address ?? 'Where to?', true),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),

          if (_isLoading)
            const Center(child: CircularProgressIndicator(color: Colors.white)),

          Positioned(
            right: 20,
            bottom: (_pickup != null && _destination != null) ? 140 : 40,
            child: FloatingActionButton(
              heroTag: 'location_fab',
              backgroundColor: Colors.white,
              elevation: 8,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
              onPressed: () {
                setState(() => _shouldFollowUser = true);
                _mapController.move(_smoothedPosition!, 15.0);
              },
              child: const Icon(Icons.my_location, color: Colors.black),
            ),
          ),

          if (_pickup != null && _destination != null)
            Positioned(
              bottom: 40,
              left: 20,
              right: 20,
              child: Hero(
                tag: 'confirm_button',
                child: Container(
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(32),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withOpacity(0.4),
                        blurRadius: 20,
                        offset: const Offset(0, 10),
                      ),
                    ],
                  ),
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.white,
                      foregroundColor: Colors.black,
                      padding: const EdgeInsets.all(22),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(32)),
                    ),
                    onPressed: () {
                      Navigator.pushNamed(
                        context,
                        '/ride_request',
                        arguments: {'pickup': _pickup, 'destination': _destination},
                      );
                    },
                    child: const Text('Confirm Uberish', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, letterSpacing: 1)),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildSearchBox(String text, bool isDestination) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(32),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Colors.white, Colors.grey.shade100],
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.1),
            blurRadius: 20,
            offset: const Offset(0, 8),
          ),
          BoxShadow(
            color: Colors.white.withOpacity(0.8),
            blurRadius: 10,
            offset: const Offset(0, -4),
          ),
        ],
      ),
      child: Row(
        children: [
          Icon(
            isDestination ? Icons.square : Icons.circle,
            size: 12,
            color: Colors.black,
          ),
          const SizedBox(width: 20),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: Colors.black87),
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}
