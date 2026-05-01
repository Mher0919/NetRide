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
    final theme = Theme.of(context);

    if (rideProvider.status == models.TripStatus.COMPLETED) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _showArrivalDialog();
      });
    }

    if (driver == null) {
      return Scaffold(
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const CircularProgressIndicator(),
              const SizedBox(height: 32),
              Text(
                'Driver is on the way',
                style: theme.textTheme.headlineMedium?.copyWith(fontSize: 20),
              ),
              const SizedBox(height: 8),
              Text(
                'Preparing your premium experience...',
                style: TextStyle(color: theme.colorScheme.onSurface.withOpacity(0.5)),
              ),
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
      statusText = 'Heading to destination';
    }

    final showRiderMarker = rideProvider.status != models.TripStatus.IN_PROGRESS && _riderLocation != null;

    return Scaffold(
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
                MarkerLayer(
                  markers: [
                    Marker(
                      point: driverLocation,
                      width: 50,
                      height: 50,
                      child: Container(
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(
                          color: const Color(0xFF2F3A32),
                          shape: BoxShape.circle,
                          boxShadow: [
                            BoxShadow(
                              color: Colors.black.withOpacity(0.1),
                              blurRadius: 10,
                              spreadRadius: 2,
                            ),
                          ],
                        ),
                        child: const Icon(Icons.directions_car, color: Colors.white, size: 24),
                      ),
                    ),
                    if (showRiderMarker)
                      Marker(
                        point: _riderLocation!,
                        width: 40,
                        height: 40,
                        child: Container(
                          decoration: BoxDecoration(
                            color: const Color(0xFF5B7760).withOpacity(0.15),
                            shape: BoxShape.circle,
                          ),
                          child: const Icon(Icons.person_pin_circle, color: Color(0xFF5B7760), size: 30),
                        ),
                      ),
                  ],
                ),
              ],
            )
          else
            const Center(child: CircularProgressIndicator()),
          
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(20),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withOpacity(0.08),
                      blurRadius: 20,
                      offset: const Offset(0, 8),
                    ),
                  ],
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      statusText,
                      style: const TextStyle(
                        color: Color(0xFF2F3A32),
                        fontWeight: FontWeight.w600,
                        fontSize: 16,
                      ),
                    ),
                    Row(
                      children: [
                        Text(
                          _eta,
                          style: const TextStyle(
                            color: Color(0xFF5B7760),
                            fontWeight: FontWeight.w700,
                            fontSize: 16,
                          ),
                        ),
                        const SizedBox(width: 12),
                        Container(
                          width: 1,
                          height: 20,
                          color: const Color(0xFFD8D2CA),
                        ),
                        const SizedBox(width: 12),
                        Text(
                          _distanceRemaining,
                          style: TextStyle(
                            color: const Color(0xFF2F3A32).withOpacity(0.5),
                            fontWeight: FontWeight.w500,
                            fontSize: 14,
                          ),
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
                heroTag: 'follow_fab',
                backgroundColor: Colors.white,
                foregroundColor: const Color(0xFF2F3A32),
                elevation: 4,
                mini: true,
                shape: const CircleBorder(),
                onPressed: () {
                  if (driverLocation != null) {
                    setState(() => _shouldFollowDriver = true);
                    _mapController.move(driverLocation, 15.0);
                  }
                },
                child: const Icon(Icons.navigation),
              ),
            ),

          Positioned(
            bottom: 0,
            left: 0,
            right: 0,
            child: Container(
              padding: const EdgeInsets.fromLTRB(24, 12, 24, 32),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: const BorderRadius.vertical(top: Radius.circular(32)),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withOpacity(0.05),
                    blurRadius: 20,
                    offset: const Offset(0, -10),
                  ),
                ],
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 32,
                    height: 4,
                    decoration: BoxDecoration(
                      color: const Color(0xFFD8D2CA),
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                  const SizedBox(height: 24),
                  Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(2),
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          border: Border.all(color: const Color(0xFFD8D2CA)),
                        ),
                        child: CircleAvatar(
                          radius: 28,
                          backgroundColor: const Color(0xFFF7F4EF),
                          child: const Icon(Icons.person, color: Color(0xFF5B7760), size: 32),
                        ),
                      ),
                      const SizedBox(width: 16),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              driver.name,
                              style: const TextStyle(
                                fontSize: 20,
                                fontWeight: FontWeight.w600,
                                color: Color(0xFF2F3A32),
                              ),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              '${driver.vehicle} • ${driver.plate}',
                              style: TextStyle(
                                color: const Color(0xFF2F3A32).withOpacity(0.5),
                                fontSize: 14,
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                          ],
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                        decoration: BoxDecoration(
                          color: const Color(0xFFF7F4EF),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: const Row(
                          children: [
                            Icon(Icons.star, color: Color(0xFFC79A4A), size: 14),
                            SizedBox(width: 4),
                            Text(
                              '4.9',
                              style: TextStyle(
                                color: Color(0xFF2F3A32),
                                fontWeight: FontWeight.w700,
                                fontSize: 13,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 32),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton(
                          onPressed: () {},
                          style: OutlinedButton.styleFrom(
                            padding: const EdgeInsets.symmetric(vertical: 16),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(16),
                            ),
                          ),
                          child: const Icon(Icons.message, size: 24),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        flex: 2,
                        child: ElevatedButton(
                          onPressed: () {
                            rideProvider.cancelRide();
                            Navigator.popUntil(context, ModalRoute.withName('/'));
                          },
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFFC65A5A).withOpacity(0.1),
                            foregroundColor: const Color(0xFFC65A5A),
                            padding: const EdgeInsets.symmetric(vertical: 16),
                            elevation: 0,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(16),
                            ),
                          ),
                          child: const Text(
                            'CANCEL TRIP',
                            style: TextStyle(fontWeight: FontWeight.w700),
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
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
        title: const Text(
          'Arrived',
          style: TextStyle(fontWeight: FontWeight.w700, fontSize: 22, color: Color(0xFF2F3A32)),
          textAlign: TextAlign.center,
        ),
        content: Text(
          'You have reached your destination. We hope you enjoyed your NetRide experience.',
          style: TextStyle(fontSize: 15, color: const Color(0xFF2F3A32).withOpacity(0.7)),
          textAlign: TextAlign.center,
        ),
        actions: [
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: () {
                final rideProvider = Provider.of<RideProvider>(context, listen: false);
                rideProvider.reset();
                Navigator.popUntil(context, (route) => route.isFirst);
              },
              child: const Text('DONE'),
            ),
          ),
        ],
      ),
    );
  }
}


