import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:geolocator/geolocator.dart';
import 'package:provider/provider.dart';
import '../providers/driver_provider.dart';
import '../models/trip_models.dart' as models;
import '../services/routing_service.dart';

class TripScreen extends StatefulWidget {
  const TripScreen({super.key});

  @override
  State<TripScreen> createState() => _TripScreenState();
}

class _TripScreenState extends State<TripScreen> {
  final MapController _mapController = MapController();
  final RoutingService _routingService = RoutingService();
  StreamSubscription<Position>? _positionSubscription;
  Timer? _refreshTimer;
  List<LatLng> _polylinePoints = [];
  String _eta = 'Calculating...';
  String _distanceRemaining = '0.0 mi';
  bool _isLoadingRoute = true;
  bool _shouldFollowDriver = true;
  LatLng? _lastFetchLocation;
  DateTime? _lastFetchTime;

  @override
  void initState() {
    super.initState();
    _startLocationTracking();
    _fetchRoute();
    _startPeriodicRefresh();
  }

  void _startPeriodicRefresh() {
    _refreshTimer?.cancel();
    _refreshTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (mounted) _fetchRoute();
    });
  }

  void _fetchRoute() async {
    final driverProvider = Provider.of<DriverProvider>(context, listen: false);
    final trip = driverProvider.currentTrip;
    if (trip == null) return;

    LatLng start = driverProvider.lastLocation != null
        ? LatLng(driverProvider.lastLocation!.lat, driverProvider.lastLocation!.lng)
        : LatLng(trip.pickup.lat, trip.pickup.lng);

    LatLng end = trip.status == models.TripStatus.ACCEPTED 
        ? LatLng(trip.pickup.lat, trip.pickup.lng)
        : LatLng(trip.destination.lat, trip.destination.lng);

    final routeData = await _routingService.getRoute(start, end);

    if (mounted) {
      if (routeData.isNotEmpty) {
        final List<LatLng> points = routeData['points_list'] ?? [start, end];

        int durationSeconds = (routeData['duration'] as num).toInt();
        int minutes = (durationSeconds / 60).ceil();

        double distanceMeters = (routeData['distance'] as num).toDouble();
        double distanceMiles = distanceMeters * 0.000621371;

        setState(() {
          _polylinePoints = points;
          _eta = minutes <= 0 ? '1 min' : '$minutes min';
          _distanceRemaining = '${distanceMiles.toStringAsFixed(1)} mi';
          _isLoadingRoute = false;
          _lastFetchTime = DateTime.now();
        });

        
        if (_lastFetchLocation == null && _polylinePoints.isNotEmpty) {
           _mapController.move(start, 15.0);
        }
        _lastFetchLocation = start;
      } else {
        setState(() {
          _isLoadingRoute = false;
          _eta = '-- min';
        });
      }
    }
  }

  void _startLocationTracking() {
    final driverProvider = Provider.of<DriverProvider>(context, listen: false);
    _positionSubscription = Geolocator.getPositionStream(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.bestForNavigation,
        distanceFilter: 10,
      ),
    ).listen((Position position) {
      if (mounted) {
        driverProvider.updateLocation(
          position.latitude, 
          position.longitude, 
          heading: position.heading
        );
        
        final currentLoc = LatLng(position.latitude, position.longitude);

        if (_shouldFollowDriver) {
          _mapController.move(currentLoc, _mapController.camera.zoom);
        }

        // Optimized re-route threshold: 100m AND 1s throttle
        bool timeThrottled = _lastFetchTime != null && 
            DateTime.now().difference(_lastFetchTime!).inSeconds < 1;

        if (!timeThrottled && (_lastFetchLocation == null || 
            const Distance().as(LengthUnit.Meter, _lastFetchLocation!, currentLoc) > 100 ||
            _isOffRoute(currentLoc))) {
          _fetchRoute();
        }
      }
    });
  }

  bool _isOffRoute(LatLng currentPos) {
    if (_polylinePoints.isEmpty) return false;
    for (int i = 0; i < _polylinePoints.length; i += 5) {
      if (const Distance().as(LengthUnit.Meter, currentPos, _polylinePoints[i]) < 50) {
        return false;
      }
    }
    return true; 
  }

  @override
  void dispose() {
    _positionSubscription?.cancel();
    _refreshTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final driverProvider = Provider.of<DriverProvider>(context);
    final trip = driverProvider.currentTrip;

    // Auto-pop when trip is completed or cancelled by backend
    // BUT wait 2 seconds first to allow for socket/navigation race conditions
    if (trip == null) {
      Future.delayed(const Duration(seconds: 2), () {
        if (mounted && Navigator.canPop(context)) {
          final p = Provider.of<DriverProvider>(context, listen: false);
          if (p.currentTrip == null) {
            Navigator.pop(context);
          }
        }
      });
      return const Scaffold(
        backgroundColor: Colors.white,
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              CircularProgressIndicator(color: Colors.black),
              SizedBox(height: 20),
              Text('Finalizing trip details...', style: TextStyle(fontWeight: FontWeight.bold)),
            ],
          ),
        ),
      );
    }

    final currentPosition = driverProvider.lastLocation != null
        ? LatLng(driverProvider.lastLocation!.lat, driverProvider.lastLocation!.lng)
        : LatLng(trip.pickup.lat, trip.pickup.lng);
    
    final pickupLocation = LatLng(trip.pickup.lat, trip.pickup.lng);
    final destinationLocation = LatLng(trip.destination.lat, trip.destination.lng);
    final riderLocation = driverProvider.riderLocation != null 
        ? LatLng(driverProvider.riderLocation!.lat, driverProvider.riderLocation!.lng) 
        : pickupLocation;

    final showRiderMarker = trip.status != models.TripStatus.IN_PROGRESS;

    // Proximity check: within 200m to pick up
    double distanceToPickup = const Distance().as(LengthUnit.Meter, currentPosition, pickupLocation);
    bool canPickUp = distanceToPickup < 200;

    return Scaffold(
      backgroundColor: const Color(0xFFF5F5F5),
      body: Stack(
        children: [
          FlutterMap(
            mapController: _mapController,
            options: MapOptions(
              initialCenter: currentPosition,
              initialZoom: 15.0,
              onPositionChanged: (pos, hasGesture) {
                if (hasGesture) {
                  setState(() => _shouldFollowDriver = false);
                }
              },
            ),
            children: [
              TileLayer(
                urlTemplate: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
                subdomains: const ['a', 'b', 'c', 'd'],
                userAgentPackageName: 'com.uberish.driver',
                tileBuilder: (context, tileWidget, tile) {
                  return ColorFiltered(
                    colorFilter: const ColorFilter.matrix([
                      0.2126, 0.7152, 0.0722, 0, 0,
                      0.2126, 0.7152, 0.0722, 0, 0,
                      0.2126, 0.7152, 0.0722, 0, 0,
                      0,      0,      0,      1, 0,
                    ]),
                    child: tileWidget,
                  );
                },
              ),
              if (_polylinePoints.isNotEmpty)
                PolylineLayer(
                  polylines: [
                    Polyline(
                      points: _polylinePoints,
                      strokeWidth: 12.0,
                      color: Colors.black.withOpacity(0.15),
                      strokeCap: StrokeCap.round,
                      strokeJoin: StrokeJoin.round,
                    ),
                    Polyline(
                      points: _polylinePoints,
                      strokeWidth: 7.0,
                      color: Colors.black,
                      strokeCap: StrokeCap.round,
                      strokeJoin: StrokeJoin.round,
                    ),
                  ],
                ),
              MarkerLayer(
                markers: [
                  if (trip.status == models.TripStatus.ACCEPTED)
                    Marker(
                      point: pickupLocation,
                      width: 40,
                      height: 40,
                      child: Container(
                        decoration: BoxDecoration(
                          color: Colors.blueAccent.withOpacity(0.2),
                          shape: BoxShape.circle,
                          border: Border.all(color: Colors.blueAccent, width: 2),
                        ),
                        child: const Center(child: Icon(Icons.location_on, color: Colors.blueAccent, size: 20)),
                      ),
                    ),
                  if (showRiderMarker && driverProvider.riderLocation != null)
                    Marker(
                      point: riderLocation,
                      width: 50,
                      height: 50,
                      child: const Icon(Icons.person_pin_circle, color: Colors.blueAccent, size: 40),
                    ),
                  if (showRiderMarker && driverProvider.riderLocation == null)
                    Marker(
                      point: pickupLocation,
                      width: 50,
                      height: 50,
                      child: const Icon(Icons.person_pin_circle, color: Colors.blueAccent, size: 40),
                    ),
                  Marker(
                    point: currentPosition,
                    width: 60,
                    height: 60,
                    child: Transform.rotate(
                      angle: (driverProvider.heading * (math.pi / 180)),
                      child: Container(
                        decoration: BoxDecoration(
                          color: Colors.black,
                          shape: BoxShape.circle,
                          boxShadow: [
                            BoxShadow(color: Colors.black.withOpacity(0.3), blurRadius: 10),
                          ],
                        ),
                        child: const Icon(Icons.navigation, color: Colors.white, size: 30),
                      ),
                    ),
                  ),
                  Marker(
                    point: destinationLocation,
                    width: 40,
                    height: 40,
                    child: const Icon(Icons.flag, color: Colors.redAccent, size: 35),
                  ),
                ],
              ),
            ],
          ),

          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
                decoration: BoxDecoration(
                  color: Colors.black,
                  borderRadius: BorderRadius.circular(32),
                  boxShadow: [
                    BoxShadow(color: Colors.black.withOpacity(0.3), blurRadius: 15, offset: const Offset(0, 8)),
                  ],
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.timer_outlined, color: Colors.greenAccent, size: 20),
                    const SizedBox(width: 12),
                    Text(_eta, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 18)),
                    const SizedBox(width: 12),
                    Container(width: 1, height: 20, color: Colors.white24),
                    const SizedBox(width: 12),
                    Text(_distanceRemaining, style: const TextStyle(color: Colors.white70, fontWeight: FontWeight.bold, fontSize: 16)),
                  ],
                ),
              ),
            ),
          ),

          if (!_shouldFollowDriver)
            Positioned(
              right: 20,
              bottom: 280,
              child: FloatingActionButton(
                backgroundColor: Colors.white,
                elevation: 8,
                mini: true,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                onPressed: () {
                  if (currentPosition != null) {
                    setState(() => _shouldFollowDriver = true);
                    _mapController.move(currentPosition, 15.0);
                  }
                },
                child: const Icon(Icons.navigation, color: Colors.black),
              ),
            ),

          if (_isLoadingRoute)
            const Center(child: CircularProgressIndicator(color: Colors.black)),

          Positioned(
            bottom: 0,
            left: 0,
            right: 0,
            child: Container(
              padding: const EdgeInsets.all(25),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: const BorderRadius.only(
                  topLeft: Radius.circular(40),
                  topRight: Radius.circular(40),
                ),
                boxShadow: [
                  BoxShadow(color: Colors.black.withOpacity(0.15), blurRadius: 30, offset: const Offset(0, -10)),
                ],
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 40,
                    height: 4,
                    margin: const EdgeInsets.only(bottom: 20),
                    decoration: BoxDecoration(color: Colors.grey[300], borderRadius: BorderRadius.circular(10)),
                  ),
                  Text(
                    trip.status == models.TripStatus.ACCEPTED ? 'EN ROUTE TO PICKUP' : 'EN ROUTE TO DESTINATION',
                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w900, letterSpacing: 1.5, color: Colors.grey),
                  ),
                  const SizedBox(height: 15),
                  Text(
                    trip.status == models.TripStatus.ACCEPTED ? trip.pickup.address ?? 'Pickup' : trip.destination.address ?? 'Destination',
                    style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w900, letterSpacing: -0.5),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 35),
                  SizedBox(
                    width: double.infinity,
                    child: Container(
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(32),
                        boxShadow: [
                          BoxShadow(color: Colors.black.withOpacity(0.3), blurRadius: 15, offset: const Offset(0, 8)),
                        ],
                      ),
                      child: ElevatedButton(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: Colors.black,
                          disabledBackgroundColor: Colors.grey[300],
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.all(22),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(32)),
                        ),
                        onPressed: (trip.status == models.TripStatus.ACCEPTED && !canPickUp) ? null : () {
                          if (trip.status == models.TripStatus.ACCEPTED) {
                            driverProvider.pickUpRider(trip.id);
                            _fetchRoute(); 
                          } else {
                            driverProvider.completeTrip(trip.id);
                            Navigator.pop(context);
                          }
                        },
                        child: Text(
                          trip.status == models.TripStatus.ACCEPTED ? 'PICK UP RIDER' : 'FINISH RIDE',
                          style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w900, letterSpacing: 2),
                        ),
                      ),
                    ),
                  ),
                  if (trip.status == models.TripStatus.ACCEPTED && !canPickUp)
                    Padding(
                      padding: const EdgeInsets.only(top: 10),
                      child: Text(
                        'Drive closer to pickup (${distanceToPickup.toInt()}m)',
                        style: const TextStyle(color: Colors.red, fontWeight: FontWeight.bold),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
