import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:geolocator/geolocator.dart';
import 'package:provider/provider.dart';
import '../providers/ride_provider.dart';
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
  bool _shouldFollowDriver = true;
  String _eta = 'Calculating...';
  String _distanceRemaining = '0.0 mi';
  LatLng? _lastCalcLocation;
  LatLng? _riderLocation;

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
    final rideProvider = Provider.of<RideProvider>(context, listen: false);
    final driver = rideProvider.driver;
    final trip = rideProvider.currentTrip;

    if (driver?.location != null && trip != null) {
      LatLng start = LatLng(driver!.location!.lat, driver.location!.lng);
      _lastCalcLocation = start;
      LatLng end = rideProvider.status == models.TripStatus.IN_PROGRESS 
          ? LatLng(trip.destination.lat, trip.destination.lng)
          : LatLng(trip.pickup.lat, trip.pickup.lng);
      
      final routeData = await _routingService.getRoute(start, end);
      if (mounted) {
        if (routeData.isNotEmpty) {
          int durationSeconds = (routeData['duration'] as num).toInt();
          int minutes = (durationSeconds / 60).ceil();

          double distanceMeters = (routeData['distance'] as num).toDouble();
          double distanceMiles = distanceMeters * 0.000621371;

          setState(() {
            _eta = minutes <= 0 ? '1 min' : '$minutes min';
            _distanceRemaining = '${distanceMiles.toStringAsFixed(1)} mi';
          });
        } else {
          setState(() {
            _eta = '-- min';
            _distanceRemaining = '-- mi';
          });
        }
      }
    }
  }

  void _startLocationTracking() {
    final rideProvider = Provider.of<RideProvider>(context, listen: false);
    _positionSubscription = Geolocator.getPositionStream(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.bestForNavigation,
        distanceFilter: 10,
      ),
    ).listen((Position position) {
      if (mounted) {
        final currentLoc = LatLng(position.latitude, position.longitude);
        setState(() {
          _riderLocation = currentLoc;
        });
        rideProvider.updateLocation(position.latitude, position.longitude);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final rideProvider = Provider.of<RideProvider>(context);
    final driver = rideProvider.driver;

    if (rideProvider.status == models.TripStatus.COMPLETED) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _showArrivalDialog();
      });
    }

    if (driver == null) {
      return const Scaffold(
        backgroundColor: Color(0xFFF5F5F5),
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              CircularProgressIndicator(color: Colors.black, strokeWidth: 3),
              SizedBox(height: 25),
              Text('Your driver is on the way', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Colors.black)),
              Text('Preparing trip details...', style: TextStyle(color: Colors.grey)),
            ],
          ),
        ),
      );
    }

    final driverLocation = driver.location != null 
        ? LatLng(driver.location!.lat, driver.location!.lng)
        : null;

    if (driverLocation != null) {
      if (_shouldFollowDriver) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) {
            _mapController.move(driverLocation, 15.0);
          }
        });
      }
    }

    String statusText = 'Driver is arriving';
    if (rideProvider.status == models.TripStatus.IN_PROGRESS) {
      statusText = 'Proceeding to destination';
    }

    final showRiderMarker = rideProvider.status != models.TripStatus.IN_PROGRESS && _riderLocation != null;

    return Scaffold(
      backgroundColor: const Color(0xFFF5F5F5),
      body: Stack(
        children: [
          if (driverLocation != null)
            FlutterMap(
              mapController: _mapController,
              options: MapOptions(
                initialCenter: driverLocation,
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
                  userAgentPackageName: 'com.uberish.rider',
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
                MarkerLayer(
                  markers: [
                    Marker(
                      point: driverLocation,
                      width: 70,
                      height: 70,
                      child: Column(
                        children: [
                          Container(
                            padding: const EdgeInsets.all(8),
                            decoration: BoxDecoration(
                              color: Colors.black,
                              shape: BoxShape.circle,
                              boxShadow: [
                                BoxShadow(color: Colors.blue.withOpacity(0.5), blurRadius: 15, spreadRadius: 2),
                              ],
                            ),
                            child: const Icon(Icons.directions_car, color: Colors.white, size: 30),
                          ),
                        ],
                      ),
                    ),
                    if (showRiderMarker)
                      Marker(
                        point: _riderLocation!,
                        width: 60,
                        height: 60,
                        child: Container(
                          decoration: BoxDecoration(
                            color: Colors.blueAccent.withOpacity(0.2),
                            shape: BoxShape.circle,
                          ),
                          child: const Icon(Icons.person_pin_circle, color: Colors.blueAccent, size: 40),
                        ),
                      ),
                  ],
                ),
              ],
            )
          else
            const Center(child: CircularProgressIndicator(color: Colors.black)),
          
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
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(statusText, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16)),
                    Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                          decoration: BoxDecoration(color: Colors.white.withOpacity(0.1), borderRadius: BorderRadius.circular(20)),
                          child: Text(_distanceRemaining, style: const TextStyle(color: Colors.white70, fontWeight: FontWeight.bold, fontSize: 14)),
                        ),
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                          decoration: BoxDecoration(color: Colors.white.withOpacity(0.2), borderRadius: BorderRadius.circular(20)),
                          child: Text(_eta, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 16)),
                        ),
                      ],
                    ),
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
                  if (driverLocation != null) {
                    setState(() => _shouldFollowDriver = true);
                    _mapController.move(driverLocation, 15.0);
                  }
                },
                child: const Icon(Icons.navigation, color: Colors.black),
              ),
            ),

          Positioned(
            bottom: 0,
            left: 0,
            right: 0,
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 500),
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
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Row(
                        children: [
                          Container(
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              border: Border.all(color: Colors.grey.shade200, width: 2),
                            ),
                            child: CircleAvatar(
                              radius: 30,
                              backgroundColor: Colors.grey[100],
                              child: const Icon(Icons.person, color: Colors.black54, size: 35),
                            ),
                          ),
                          const SizedBox(width: 15),
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(driver.name, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w900, letterSpacing: -0.5)),
                              Text('${driver.vehicle} • ${driver.plate}', style: const TextStyle(color: Colors.grey, fontSize: 14, fontWeight: FontWeight.bold)),
                            ],
                          ),
                        ],
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                        decoration: BoxDecoration(
                          color: Colors.black,
                          borderRadius: BorderRadius.circular(20),
                          boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.2), blurRadius: 10, offset: const Offset(0, 4))],
                        ),
                        child: const Row(
                          children: [
                            Icon(Icons.star, color: Colors.amber, size: 16),
                            SizedBox(width: 6),
                            Text('4.9', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900)),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 30),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton(
                          onPressed: () {},
                          style: OutlinedButton.styleFrom(
                            padding: const EdgeInsets.all(20),
                            side: BorderSide(color: Colors.grey.shade300, width: 2),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
                          ),
                          child: const Icon(Icons.message, color: Colors.black, size: 28),
                        ),
                      ),
                      const SizedBox(width: 15),
                      Expanded(
                        flex: 3,
                        child: Container(
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(24),
                            boxShadow: [
                              BoxShadow(color: Colors.redAccent.withOpacity(0.2), blurRadius: 15, offset: const Offset(0, 8)),
                            ],
                          ),
                          child: ElevatedButton(
                            style: ElevatedButton.styleFrom(
                              backgroundColor: Colors.red.withOpacity(0.08),
                              foregroundColor: Colors.redAccent,
                              padding: const EdgeInsets.all(20),
                              elevation: 0,
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
                            ),
                            onPressed: () {
                              rideProvider.cancelRide();
                              Navigator.popUntil(context, ModalRoute.withName('/'));
                            },
                            child: const Text('CANCEL TRIP', style: TextStyle(fontWeight: FontWeight.w900, fontSize: 16, letterSpacing: 1.5)),
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  void _showArrivalDialog() {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(32)),
        title: const Text('Arrived!', style: TextStyle(fontWeight: FontWeight.w900, fontSize: 24)),
        content: const Text('You have reached your destination. Hope you had a great ride with Uberish!', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w500)),
        actions: [
          Padding(
            padding: const EdgeInsets.all(10),
            child: ElevatedButton(
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.black,
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(horizontal: 30, vertical: 15),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
              ),
              onPressed: () {
                final rideProvider = Provider.of<RideProvider>(context, listen: false);
                rideProvider.reset();
                Navigator.popUntil(context, (route) => route.isFirst);
              },
              child: const Text('DONE', style: TextStyle(fontWeight: FontWeight.bold)),
            ),
          ),
        ],
      ),
    );
  }
}
