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
import '../services/communication_service.dart';
import '../components/smooth_driver_marker.dart';
import '../components/state_container.dart';
import 'rating_screen.dart';
import 'chat_sheet.dart';
import 'call_overlay.dart';

class TripScreen extends StatefulWidget {
  const TripScreen({super.key});

  @override
  State<TripScreen> createState() => _TripScreenState();
}

class _TripScreenState extends State<TripScreen> {
  final MapController _mapController = MapController();
  final RoutingService _routingService = RoutingService();
  LatLng? _riderLocation;
  List<LatLng> _routePoints = [];
  StreamSubscription<Position>? _positionSubscription;
  Timer? _refreshTimer;
  bool _isMapReady = false;

  @override
  void initState() {
    super.initState();
    _initLocationTracking();
    _fetchRoute();
    _startPeriodicRefresh();
  }

  void _startPeriodicRefresh() {
    _refreshTimer?.cancel();
    _refreshTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (mounted) _fetchRoute();
    });
  }

  Future<void> _initLocationTracking() async {
    _positionSubscription = Geolocator.getPositionStream(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.bestForNavigation,
        distanceFilter: 0,
      ),
    ).listen((position) {
      if (mounted) {
        setState(() {
          _riderLocation = LatLng(position.latitude, position.longitude);
        });
        Provider.of<RideProvider>(context, listen: false).updateLocation(position.latitude, position.longitude);
      }
    });
  }

  Future<void> _fetchRoute() async {
    final rideProvider = Provider.of<RideProvider>(context, listen: false);
    final trip = rideProvider.currentTrip;
    final driver = rideProvider.driver;
    
    if (trip == null || driver == null || driver.location == null) return;

    try {
      LatLng start = LatLng(driver.location!.lat, driver.location!.lng);
      LatLng end = trip.status == models.TripStatus.ACCEPTED 
          ? LatLng(trip.pickup.lat, trip.pickup.lng)
          : LatLng(trip.destination.lat, trip.destination.lng);

      final route = await _routingService.getRoute(start, end);
      if (mounted) {
        setState(() {
          _routePoints = route['points_list'] as List<LatLng>;
        });
      }
    } catch (e) {
      debugPrint('Route fetch error: $e');
    }
  }

  @override
  void dispose() {
    _positionSubscription?.cancel();
    _refreshTimer?.cancel();
    super.dispose();
  }

  void _showArrivalDialog() {
    final rideProvider = Provider.of<RideProvider>(context, listen: false);
    final trip = rideProvider.currentTrip;
    if (trip == null) return;

    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (context) => _SavingsArrivalDialog(trip: trip),
    );
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
        body: StateContainer(
          state: ViewState.loading,
          loadingWidget: Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const CircularProgressIndicator(color: Color(0xFF5B7760)),
                const SizedBox(height: 32),
                Text(
                  'Securing your driver...',
                  style: theme.textTheme.headlineMedium?.copyWith(fontSize: 20, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 12),
                Text(
                  'Your premium vehicle is on its way.',
                  style: TextStyle(color: const Color(0xFF2F3A32).withOpacity(0.5), fontWeight: FontWeight.w500),
                ),
              ],
            ),
          ),
          successWidget: const SizedBox(),
        ),
      );
    }

    final driverLocation = driver.location != null 
        ? LatLng(driver.location!.lat, driver.location!.lng) 
        : LatLng(rideProvider.currentTrip!.pickup.lat, rideProvider.currentTrip!.pickup.lng);

    return Scaffold(
      body: Stack(
        children: [
          FlutterMap(
            mapController: _mapController,
            options: MapOptions(
              initialCenter: driverLocation,
              initialZoom: 15.0,
              onMapReady: () => setState(() => _isMapReady = true),
            ),
            children: [
              TileLayer(
                urlTemplate: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
                subdomains: const ['a', 'b', 'c', 'd'],
                userAgentPackageName: 'com.NetRide.rider',
              ),
              if (_routePoints.isNotEmpty)
                PolylineLayer(
                  polylines: [
                    Polyline(
                      points: _routePoints,
                      color: const Color(0xFF5B7760),
                      strokeWidth: 4.0,
                    ),
                  ],
                ),
              MarkerLayer(
                markers: [
                  if (_riderLocation != null)
                    Marker(
                      point: _riderLocation!,
                      width: 40,
                      height: 40,
                      child: Container(
                        decoration: BoxDecoration(
                          color: const Color(0xFF5B7760).withOpacity(0.2),
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(Icons.person_pin_circle, color: Color(0xFF5B7760), size: 30),
                      ),
                    ),
                  if (rideProvider.status == models.TripStatus.IN_PROGRESS)
                    Marker(
                      point: LatLng(rideProvider.currentTrip!.destination.lat, rideProvider.currentTrip!.destination.lng),
                      width: 30,
                      height: 30,
                      child: const Icon(Icons.location_on, color: Color(0xFF2F3A32), size: 30),
                    ),
                ],
              ),
              SmoothDriverMarker(
                driverId: driver.id,
                position: driverLocation,
                heading: 0,
              ),
            ],
          ),

          // Top Info Card
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Container(
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(24),
                  boxShadow: [
                    BoxShadow(color: Colors.black.withOpacity(0.08), blurRadius: 20, offset: const Offset(0, 10)),
                  ],
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      children: [
                        const CircleAvatar(
                          backgroundColor: Color(0xFFF7F4EF),
                          child: Icon(Icons.local_taxi, color: Color(0xFF5B7760)),
                        ),
                        const SizedBox(width: 16),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                rideProvider.status == models.TripStatus.ACCEPTED ? 'DRIVER IS ARRIVING' : 'TRIP IN PROGRESS',
                                style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w800, letterSpacing: 1, color: Color(0xFF5B7760)),
                              ),
                              Text(
                                driver.name,
                                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
                              ),
                            ],
                          ),
                        ),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Text(
                              driver.plate,
                              style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14),
                            ),
                            Text(
                              driver.vehicle,
                              style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),

          // Bottom Controls
          Positioned(
            bottom: 0,
            left: 0,
            right: 0,
            child: Container(
              padding: const EdgeInsets.fromLTRB(24, 12, 24, 40),
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
                    decoration: BoxDecoration(color: Colors.grey.shade200, borderRadius: BorderRadius.circular(2)),
                  ),
                  const SizedBox(height: 24),
                  Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              rideProvider.status == models.TripStatus.ACCEPTED ? 'PICKUP' : 'DESTINATION',
                              style: TextStyle(fontSize: 10, fontWeight: FontWeight.w800, color: Colors.grey.shade400, letterSpacing: 1),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              rideProvider.status == models.TripStatus.ACCEPTED ? rideProvider.currentTrip!.pickup.address! : rideProvider.currentTrip!.destination.address!,
                              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 16),
                      _ChatCallButtons(tripId: rideProvider.tripId ?? '', peerName: driver.name),
                    ],
                  ),
                ],
              ),
            ),
          ),

          const CallOverlayHost(),
        ],
      ),
    );
  }
}

class _SavingsArrivalDialog extends StatefulWidget {
  final models.Trip trip;
  const _SavingsArrivalDialog({required this.trip});

  @override
  State<_SavingsArrivalDialog> createState() => _SavingsArrivalDialogState();
}

class _SavingsArrivalDialogState extends State<_SavingsArrivalDialog> with TickerProviderStateMixin {
  late AnimationController _strikeThroughController;
  late AnimationController _fadeController;
  late Animation<double> _strikeThroughProgress;
  late Animation<double> _fadeProgress;

  @override
  void initState() {
    super.initState();
    _strikeThroughController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 600),
    );
    _fadeController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 800),
    );

    _strikeThroughProgress = Tween<double>(begin: 0.0, end: 1.0).animate(
      CurvedAnimation(parent: _strikeThroughController, curve: Curves.easeInOut),
    );
    _fadeProgress = Tween<double>(begin: 0.0, end: 1.0).animate(
      CurvedAnimation(parent: _fadeController, curve: Curves.easeOutBack),
    );

    Future.delayed(const Duration(milliseconds: 600), () {
      if (mounted) {
        _strikeThroughController.forward();
      }
    });

    Future.delayed(const Duration(milliseconds: 1100), () {
      if (mounted) {
        _fadeController.forward();
      }
    });
  }

  @override
  void dispose() {
    _strikeThroughController.dispose();
    _fadeController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final maxFare = widget.trip.initialMaxFare ?? 0.0;
    final finalFare = widget.trip.fareAmount ?? 0.0;
    final savings = maxFare - finalFare;

    return AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(28)),
      backgroundColor: Colors.white,
      title: const Center(
        child: Text(
          'You have arrived! 🎉',
          style: TextStyle(fontWeight: FontWeight.w900, fontSize: 22, color: Color(0xFF2F3A32)),
        ),
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text(
            'Your trip is complete. Here is your final fare summary:',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 13, color: Colors.grey, height: 1.5),
          ),
          const SizedBox(height: 24),
          if (savings > 0) ...[
            Container(
              padding: const EdgeInsets.symmetric(vertical: 20, horizontal: 16),
              decoration: BoxDecoration(
                color: const Color(0xFF5B7760).withOpacity(0.05),
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: const Color(0xFF5B7760).withOpacity(0.1)),
              ),
              child: Column(
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Text(
                        'Estimated Max: ',
                        style: TextStyle(fontSize: 14, color: Colors.grey, fontWeight: FontWeight.w500),
                      ),
                      AnimatedBuilder(
                        animation: _strikeThroughProgress,
                        builder: (context, child) {
                          return CustomPaint(
                            foregroundPainter: _StrikeThroughPainter(_strikeThroughProgress.value),
                            child: Text(
                              '\$${maxFare.toStringAsFixed(2)}',
                              style: const TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.w700,
                                color: Colors.grey,
                              ),
                            ),
                          );
                        },
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  FadeTransition(
                    opacity: _fadeProgress,
                    child: ScaleTransition(
                      scale: _fadeProgress,
                      child: Column(
                        children: [
                          const Text(
                            'Actual Charged',
                            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800, color: Color(0xFF5B7760), letterSpacing: 1),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            '\$${finalFare.toStringAsFixed(2)}',
                            style: const TextStyle(
                              fontSize: 36,
                              fontWeight: FontWeight.w900,
                              color: Color(0xFF2F3A32),
                              letterSpacing: -1,
                            ),
                          ),
                          const SizedBox(height: 16),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                            decoration: BoxDecoration(
                              color: const Color(0xFF5B7760),
                              borderRadius: BorderRadius.circular(12),
                              boxShadow: [
                                BoxShadow(
                                  color: const Color(0xFF5B7760).withOpacity(0.3),
                                  blurRadius: 10,
                                  offset: const Offset(0, 4),
                                ),
                              ],
                            ),
                            child: Text(
                              'Congrats! You saved \$${savings.toStringAsFixed(2)}',
                              style: const TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.w900,
                                color: Colors.white,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ] else ...[
            Text(
              '\$${finalFare.toStringAsFixed(2)}',
              style: const TextStyle(fontSize: 38, fontWeight: FontWeight.w900, color: Color(0xFF2F3A32)),
            ),
          ],
          const SizedBox(height: 16),
        ],
      ),
      actionsAlignment: MainAxisAlignment.center,
      actions: [
        SizedBox(
          width: double.infinity,
          height: 48,
          child: ElevatedButton(
            onPressed: () {
              final rideProvider = Provider.of<RideProvider>(context, listen: false);
              final trip = rideProvider.currentTrip;
              rideProvider.reset();
              Navigator.pop(context); // Close dialog
              if (trip != null) {
                Navigator.pushReplacement(
                  context, 
                  MaterialPageRoute(builder: (context) => RatingScreen(trip: trip))
                );
              } else {
                Navigator.pop(context);
              }
            },
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF2F3A32),
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
            ),
            child: const Text('RATE YOUR TRIP', style: TextStyle(fontWeight: FontWeight.bold, letterSpacing: 0.5)),
          ),
        ),
      ],
    );
  }
}

class _StrikeThroughPainter extends CustomPainter {
  final double progress;
  _StrikeThroughPainter(this.progress);

  @override
  void paint(Canvas canvas, Size size) {
    if (progress == 0.0) return;
    final paint = Paint()
      ..color = const Color(0xFFC65A5A)
      ..strokeWidth = 2.0
      ..strokeCap = StrokeCap.round;

    double endX = size.width * progress;
    canvas.drawLine(
      Offset(-2, size.height / 2 + 1),
      Offset(endX + 2, size.height / 2 - 1),
      paint,
    );
  }

  @override
  bool shouldRepaint(covariant _StrikeThroughPainter oldDelegate) {
    return oldDelegate.progress != progress;
  }
}

class _ChatCallButtons extends StatelessWidget {
  final String tripId;
  final String peerName;

  const _ChatCallButtons({required this.tripId, required this.peerName});

  Future<void> _openChat(BuildContext context) async {
    final rideProvider = Provider.of<RideProvider>(context, listen: false);
    final comm = context.read<CommunicationService>();
    final riderId = await _readUserId();
    await comm.attachAndLoad(
      socket: rideProvider.socket,
      userId: riderId,
      tripId: tripId,
      peerName: peerName,
    );
    if (!context.mounted) return;
    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => ChatSheet(tripId: tripId, peerName: peerName),
    );
  }

  Future<void> _startCall(BuildContext context) async {
    final rideProvider = Provider.of<RideProvider>(context, listen: false);
    final comm = context.read<CommunicationService>();
    final riderId = await _readUserId();
    await comm.attachAndLoad(
      socket: rideProvider.socket,
      userId: riderId,
      tripId: tripId,
      peerName: peerName,
    );
    if (!context.mounted) return;
    final ok = await comm.startCall();
    if (!ok && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(comm.lastError ?? 'Call failed.')),
      );
    }
  }

  Future<String?> _readUserId() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('user_id');
  }

  @override
  Widget build(BuildContext context) {
    final comm = context.watch<CommunicationService>();
    final callActive = comm.callPhase != CallPhase.idle;

    return Row(
      children: [
        IconButton(
          tooltip: 'Chat',
          onPressed: () => _openChat(context),
          icon: const Icon(Icons.chat_bubble_outline, color: Color(0xFF2F3A32)),
          style: IconButton.styleFrom(
            backgroundColor: const Color(0xFFF7F4EF),
            padding: const EdgeInsets.all(12),
          ),
        ),
        const SizedBox(width: 12),
        IconButton(
          tooltip: 'Call',
          onPressed: callActive ? null : () => _startCall(context),
          icon: Icon(
            callActive ? Icons.phone_in_talk_rounded : Icons.phone_outlined,
            color: const Color(0xFF2F3A32),
          ),
          style: IconButton.styleFrom(
            backgroundColor: callActive
                ? const Color(0xFF5B7760).withOpacity(0.15)
                : const Color(0xFFF7F4EF),
            padding: const EdgeInsets.all(12),
          ),
        ),
      ],
    );
  }
}

/// Wraps the CallOverlay so it can read the CommunicationService and
/// the rider's current trip context from the same Provider tree.
class CallOverlayHost extends StatelessWidget {
  const CallOverlayHost({super.key});

  @override
  Widget build(BuildContext context) {
    return Consumer<CommunicationService>(
      builder: (context, comm, _) {
        if (comm.callPhase == CallPhase.idle) return const SizedBox.shrink();
        final provider = Provider.of<RideProvider>(context, listen: false);
        final peer = comm.peerName ?? provider.driver?.name ?? 'Your driver';
        return Positioned.fill(child: CallOverlay(peerName: peer));
      },
    );
  }
}
