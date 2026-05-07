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
  bool _isMapReady = false;
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

            if (_lastFetchLocation == null && _polylinePoints.isNotEmpty && _isMapReady) {
              Future.delayed(const Duration(milliseconds: 50), () {
                try {
                  if (mounted && _isMapReady) {
                    _mapController.move(start, 15.0);
                  }
                } catch (e) {
                  debugPrint('Map initial move error: $e');
                }
              });
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

            if (_shouldFollowDriver && _isMapReady) {
              try {
                _mapController.move(currentLoc, _mapController.camera.zoom);
              } catch (e) {
                debugPrint('Map follow move error: $e');
              }
            }
// ... rest of method

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
    final theme = Theme.of(context);

    if (trip == null) {
      Future.delayed(const Duration(seconds: 2), () {
        if (mounted && Navigator.canPop(context)) {
          final p = Provider.of<DriverProvider>(context, listen: false);
          if (p.currentTrip == null) Navigator.pop(context);
        }
      });
      return const Scaffold(
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              CircularProgressIndicator(),
              SizedBox(height: 24),
              Text('Finalizing trip details...', style: TextStyle(fontWeight: FontWeight.w600)),
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
    double distanceToPickup = const Distance().as(LengthUnit.Meter, currentPosition, pickupLocation);
    bool canPickUp = distanceToPickup < 200;

    return Scaffold(
      body: Stack(
        children: [
          FlutterMap(
            mapController: _mapController,
            options: MapOptions(
              initialCenter: currentPosition,
              initialZoom: 15.0,
              onMapReady: () {
                setState(() => _isMapReady = true);
              },
              onPositionChanged: (pos, hasGesture) {
                if (hasGesture) setState(() => _shouldFollowDriver = false);
              },
            ),
            children: [
              TileLayer(
                urlTemplate: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
                subdomains: const ['a', 'b', 'c', 'd'],
                userAgentPackageName: 'com.NetRide.driver',
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
              if (_polylinePoints.isNotEmpty)
                PolylineLayer(
                  polylines: [
                    Polyline(
                      points: _polylinePoints,
                      strokeWidth: 6.0,
                      color: const Color(0xFF5B7760),
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
                      child: _buildPinMarker(const Color(0xFF5B7760)),
                    ),
                  if (showRiderMarker)
                    Marker(
                      point: riderLocation,
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
                  Marker(
                    point: currentPosition,
                    width: 50,
                    height: 50,
                    child: Transform.rotate(
                      angle: (driverProvider.heading * (math.pi / 180)),
                      child: Container(
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(
                          color: const Color(0xFF2F3A32),
                          shape: BoxShape.circle,
                          boxShadow: [
                            BoxShadow(color: Colors.black.withOpacity(0.2), blurRadius: 10),
                          ],
                        ),
                        child: const Icon(Icons.navigation, color: Colors.white, size: 24),
                      ),
                    ),
                  ),
                  if (trip.status == models.TripStatus.IN_PROGRESS)
                    Marker(
                      point: destinationLocation,
                      width: 40,
                      height: 40,
                      child: _buildPinMarker(const Color(0xFF2F3A32)),
                    ),
                ],
              ),
            ],
          ),

          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(20),
                  boxShadow: [
                    BoxShadow(color: Colors.black.withOpacity(0.08), blurRadius: 20, offset: const Offset(0, 8)),
                  ],
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.timer_outlined, color: Color(0xFF5B7760), size: 18),
                        const SizedBox(width: 8),
                        Text(
                          _eta,
                          style: const TextStyle(color: Color(0xFF2F3A32), fontWeight: FontWeight.w700, fontSize: 16),
                        ),
                      ],
                    ),
                    Row(
                      children: [
                        Container(width: 1, height: 20, color: const Color(0xFFD8D2CA)),
                        const SizedBox(width: 16),
                        Text(
                          _distanceRemaining,
                          style: TextStyle(color: const Color(0xFF2F3A32).withOpacity(0.5), fontWeight: FontWeight.w600, fontSize: 14),
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
                  setState(() => _shouldFollowDriver = true);
                  _mapController.move(currentPosition, 15.0);
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
                  BoxShadow(color: Colors.black.withOpacity(0.05), blurRadius: 20, offset: const Offset(0, -10)),
                ],
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 32,
                    height: 4,
                    decoration: BoxDecoration(color: const Color(0xFFD8D2CA), borderRadius: BorderRadius.circular(2)),
                  ),
                  const SizedBox(height: 24),
                  Text(
                    trip.status == models.TripStatus.ACCEPTED ? 'EN ROUTE TO PICKUP' : 'EN ROUTE TO DESTINATION',
                    style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 1.5, color: const Color(0xFF2F3A32).withOpacity(0.4)),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    trip.status == models.TripStatus.ACCEPTED ? trip.pickup.address ?? 'Pickup' : trip.destination.address ?? 'Destination',
                    style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: Color(0xFF2F3A32)),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 32),
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton(
                      onPressed: (trip.status == models.TripStatus.ACCEPTED && !canPickUp) ? null : () {
                        if (trip.status == models.TripStatus.ACCEPTED) {
                          driverProvider.pickUpRider(trip.id);
                          _fetchRoute(); 
                        } else {
                          _showRiderRatingDialog();
                        }
                      },
                      child: Text(trip.status == models.TripStatus.ACCEPTED ? 'PICK UP RIDER' : 'FINISH RIDE'),
                    ),
                  ),
                  if (trip.status == models.TripStatus.ACCEPTED && !canPickUp)
                    Padding(
                      padding: const EdgeInsets.only(top: 16),
                      child: Text(
                        'Drive closer to pickup (${distanceToPickup.toInt()}m)',
                        style: const TextStyle(color: Color(0xFFC65A5A), fontWeight: FontWeight.w600, fontSize: 13),
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

  void _showRiderRatingDialog() {
    int selectedRating = 5;
    final reviewController = TextEditingController();
    bool isSubmitting = false;

    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (context) => StatefulBuilder(
        builder: (context, setState) => AlertDialog(
          backgroundColor: Colors.white,
          surfaceTintColor: Colors.transparent,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
          title: const Text(
            'Rate your Rider',
            style: TextStyle(fontWeight: FontWeight.w700, fontSize: 20, color: Color(0xFF2F3A32)),
            textAlign: TextAlign.center,
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'How was your experience with this rider?',
                style: TextStyle(fontSize: 14, color: const Color(0xFF2F3A32).withOpacity(0.7)),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 20),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: List.generate(5, (index) {
                  return IconButton(
                    icon: Icon(
                      index < selectedRating ? Icons.star : Icons.star_border,
                      color: const Color(0xFFC79A4A),
                      size: 32,
                    ),
                    onPressed: () => setState(() => selectedRating = index + 1),
                  );
                }),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: reviewController,
                maxLines: 2,
                decoration: InputDecoration(
                  hintText: 'Add a comment (optional)',
                  hintStyle: TextStyle(fontSize: 13, color: const Color(0xFF2F3A32).withOpacity(0.4)),
                  filled: true,
                  fillColor: const Color(0xFFF7F4EF),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                    borderSide: BorderSide.none,
                  ),
                ),
              ),
            ],
          ),
          actions: [
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: isSubmitting ? null : () async {
                  setState(() => isSubmitting = true);
                  final driverProvider = Provider.of<DriverProvider>(context, listen: false);
                  try {
                    if (driverProvider.currentTrip != null) {
                      await driverProvider.rateRide(
                        driverProvider.currentTrip!.id,
                        selectedRating,
                        reviewController.text.trim(),
                      );
                      await driverProvider.completeTrip(driverProvider.currentTrip!.id);
                    }
                    if (mounted) Navigator.pop(context);
                  } catch (e) {
                    if (mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Failed to submit rating: $e')));
                      setState(() => isSubmitting = false);
                    }
                  }
                },
                child: isSubmitting 
                  ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                  : const Text('SUBMIT & FINISH'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPinMarker(Color color) {
    return Stack(
      alignment: Alignment.center,
      children: [
        Icon(Icons.location_on, color: color, size: 30),
        Positioned(
          top: 6,
          child: Container(
            width: 6, height: 6,
            decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle),
          ),
        ),
      ],
    );
  }
}

