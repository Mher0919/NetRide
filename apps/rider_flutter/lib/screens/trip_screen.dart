import 'dart:async';
import '../services/secure_token_store.dart';

import 'package:confetti/confetti.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:geolocator/geolocator.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';
import '../providers/ride_provider.dart';
import '../providers/specials_provider.dart';
import '../models/trip_models.dart' as models;
import '../services/communication_service.dart';
import '../services/api_service.dart';
import '../services/location_reporter.dart';
import '../components/smooth_driver_marker.dart';
import '../components/state_container.dart';
import '../components/tip_fab.dart';
import '../components/driver_cancelled_dialog.dart';
import '../widgets/branded_map_tile.dart';
import '../widgets/special_ready_dialog.dart';
import '../utils/file_url.dart';
import 'rating_screen.dart';
import 'chat_sheet.dart';
import 'report_sheet.dart';

class TripScreen extends StatefulWidget {
  const TripScreen({super.key});

  @override
  State<TripScreen> createState() => _TripScreenState();
}

class _TripScreenState extends State<TripScreen>
    with SingleTickerProviderStateMixin {
  final MapController _mapController = MapController();
  LatLng? _riderLocation;
  StreamSubscription<Position>? _positionSubscription;
  bool _dialogShown = false;

  /// Comfortable current-location zoom: close enough to navigate, wide
  /// enough to see the surrounding streets and the car ahead.
  static const double _defaultMapZoom = 14.5;

  bool _isMapReady = false;

  /// Uber-style "follow my driver" camera mode. Tapping the locate control
  /// turns it on; any manual pan/zoom hands control back to the rider.
  /// While on, each driver fix re-centers the map on the driver's live
  /// position — position only, the camera never rotates.
  bool _followDriver = false;
  LatLng? _followDriverLocation;

  late final AnimationController _cameraFollowController;
  LatLng? _cameraFollowFrom;
  LatLng? _cameraFollowTo;
  double _cameraFollowFromZoom = _defaultMapZoom;
  double _cameraFollowToZoom = _defaultMapZoom;

  /// Throttles raw GPS fixes into a bounded 1 Hz stream so the backend
  /// is never flooded (and its socket budget never silently drops
  /// updates — which is what made the marker jitter).
  late final LocationReporter _locationReporter;

  /// Guard: exactly one cancelled dialog + one exit per ride (spec §40).
  bool _cancelledHandled = false;

  /// Guard: the pre-pickup driver-cancel apology dialog renders exactly
  /// once, then the rider is handed back to the existing search experience
  /// (the map screen's normal searching sheet) — this screen exits.
  bool _driverReleasedHandled = false;

  @override
  void initState() {
    super.initState();
    _cameraFollowController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    )..addListener(_tickCameraFollow);
    _locationReporter = LocationReporter(
      minDistanceM: 5,
      onReport: (lat, lng, {heading = 0}) {
        if (!mounted) return;
        Provider.of<RideProvider>(
          context,
          listen: false,
        ).updateLocation(lat, lng);
      },
    );
    _initLocationTracking();
  }

  Future<void> _initLocationTracking() async {
    _positionSubscription =
        Geolocator.getPositionStream(
          locationSettings: const LocationSettings(
            accuracy: LocationAccuracy.bestForNavigation,
            distanceFilter: 0,
          ),
        ).listen((position) {
          if (!mounted) return;
          // After pickup the rider and driver are one moving unit: the
          // driver's GPS is authoritative, so stop updating/reporting the
          // rider's separate position.
          final status = Provider.of<RideProvider>(
            context,
            listen: false,
          ).status;
          if (status == models.TripStatus.IN_PROGRESS ||
              status == models.TripStatus.COMPLETED ||
              status == models.TripStatus.CANCELLED) {
            return;
          }
          setState(() {
            _riderLocation = LatLng(position.latitude, position.longitude);
          });
          _locationReporter.report(position.latitude, position.longitude);
        });
  }

  /// Turns on driver-follow mode and eases the camera onto the driver.
  void _startFollowingDriver(LatLng target) {
    setState(() {
      _followDriver = true;
      _followDriverLocation = target;
    });
    _animateCameraTo(target);
  }

  /// Manual map gestures opt the rider out of follow mode so the camera
  /// never fights the rider's pan/zoom.
  void _stopFollowingDriver() {
    if (!_followDriver) return;
    _cameraFollowController.stop();
    setState(() => _followDriver = false);
  }

  /// Eases the camera center/zoom to [target], preserving rotation.
  void _animateCameraTo(LatLng target) {
    if (!_isMapReady) return;
    try {
      _cameraFollowFrom = _mapController.camera.center;
      _cameraFollowFromZoom = _mapController.camera.zoom;
    } catch (_) {
      _cameraFollowFrom = null;
      return;
    }
    _cameraFollowTo = target;
    _cameraFollowToZoom = _defaultMapZoom;
    _cameraFollowController.forward(from: 0);
  }

  void _tickCameraFollow() {
    final from = _cameraFollowFrom;
    final to = _cameraFollowTo;
    if (from == null || to == null || !_isMapReady) return;
    final t = _cameraFollowController.value;
    try {
      _mapController.move(
        LatLng(
          from.latitude + (to.latitude - from.latitude) * t,
          from.longitude + (to.longitude - from.longitude) * t,
        ),
        _cameraFollowFromZoom +
            (_cameraFollowToZoom - _cameraFollowFromZoom) * t,
      );
    } catch (_) {
      // Map detached mid-animation — nothing to do.
    }
  }

  @override
  void dispose() {
    _positionSubscription?.cancel();
    _cameraFollowController.dispose();
    super.dispose();
  }

  void _showArrivalDialog() {
    final rideProvider = Provider.of<RideProvider>(context, listen: false);
    final trip = rideProvider.currentTrip;
    if (trip == null) return;

    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (context) => _ArrivalSummaryDialog(trip: trip),
    );
  }

  /// The other party cancelled the accepted ride. Shows who + why, offers
  /// reporting (regardless of who cancelled), then resets ride state and
  /// navigates home exactly once through this single owner.
  Future<void> _handleRideCancelled(models.Trip? trip) async {
    if (!mounted) return;

    final ownId = SecureTokenStore.userId;
    final isOwnCancel = trip?.cancelledBy != null && trip!.cancelledBy == ownId;

    // Stop ride-specific tracking (driver location listener is socket-side;
    // this screen's GPS stream is cancelled in dispose).
    if (isOwnCancel) {
      // Our own cancellation already went through cancelRide() → reset().
      final rideProvider = Provider.of<RideProvider>(context, listen: false);
      rideProvider.reset();
      await showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (_) =>
            const RideCancelledDialog(cancelledTrip: null, isDriver: false),
      );
    } else {
      await showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (_) =>
            RideCancelledDialog(cancelledTrip: trip, isDriver: false),
      );
    }

    if (!mounted) return;
    final rideProvider = Provider.of<RideProvider>(context, listen: false);
    rideProvider.reset();
    // Exactly one navigation out of the active-ride state: back to Explore.
    // Stale tripUpdates are rejected while IDLE.
    _returnToExplore();
  }

  /// Driver cancelled after accepting: the backend released the SAME ride
  /// (same fare quote, promo + credits) back into normal search. Apologize
  /// (temporary, auto-dismissing), then hand the rider to the existing
  /// search experience — the map screen's searching sheet resumes the ride
  /// automatically via RideProvider.isSearchingForDriver. There is NO
  /// separate replacement-search screen.
  Future<void> _handleDriverReleased(RideProvider rideProvider) async {
    if (!mounted) return;
    rideProvider.consumeDriverCancelledNotice();
    await showDriverCancelledApology(context);
    if (!mounted) return;
    _returnToExplore();
  }

  /// Fallback for a stale /trip entry (deep link or notification tapped
  /// after the trip already settled) so the screen never hangs on the
  /// "Securing your driver..." loader forever.
  Widget _buildEndedTripScreen(ThemeData theme) {
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 88,
                height: 88,
                decoration: BoxDecoration(
                  color: const Color(0xFF5B7760).withOpacity(0.12),
                  shape: BoxShape.circle,
                ),
                child: const Icon(
                  Icons.check_circle_outline_rounded,
                  size: 42,
                  color: Color(0xFF5B7760),
                ),
              ),
              const SizedBox(height: 20),
              Text(
                'This trip has ended',
                style: theme.textTheme.headlineMedium?.copyWith(
                  fontSize: 22,
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'There is no active ride on this device right now.',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 13.5,
                  color: const Color(0xFF2F3A32).withOpacity(0.6),
                ),
              ),
              const SizedBox(height: 22),
              FilledButton(
                onPressed: _returnToExplore,
                style: FilledButton.styleFrom(
                  backgroundColor: const Color(0xFF2F3A32),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14),
                  ),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 28,
                    vertical: 14,
                  ),
                ),
                child: const Text(
                  'Back to Explore',
                  style: TextStyle(fontWeight: FontWeight.w700),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// Exactly one way back to Explore (the tab wrapper holding the map's
  /// normal search UI). Pops when the wrapper is still underneath
  /// (notification/deep-link entry); otherwise the trip screen replaced
  /// the wrapper at accept time, so a fresh wrapper is mounted.
  void _returnToExplore() {
    if (!mounted) return;
    if (Navigator.canPop(context)) {
      Navigator.pop(context);
    } else {
      Navigator.pushReplacementNamed(context, '/');
    }
  }

  void _showCancelDialog(BuildContext context, RideProvider rideProvider) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: const Text(
          'Cancel Ride?',
          style: TextStyle(fontWeight: FontWeight.w700),
        ),
        content: const Text(
          'Are you sure you want to cancel this ride? Your driver is on the way.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('No, Keep'),
          ),
          TextButton(
            onPressed: () async {
              Navigator.pop(ctx);
              // 042: cancelling an accepted ride requires a reason.
              final reason =
                  await showModalBottomSheet<({String code, String label})>(
                    context: context,
                    backgroundColor: Colors.white,
                    shape: const RoundedRectangleBorder(
                      borderRadius: BorderRadius.vertical(
                        top: Radius.circular(24),
                      ),
                    ),
                    isScrollControlled: true,
                    builder: (sheetContext) => const CancellationReasonSheet(),
                  );
              if (reason == null) return;
              try {
                final error = await rideProvider.cancelRide(
                  reasonCode: reason.code,
                  reasonText: reason.code == 'other' ? reason.label : null,
                );
                if (error != null) {
                  if (context.mounted) {
                    ScaffoldMessenger.of(
                      context,
                    ).showSnackBar(SnackBar(content: Text(error)));
                  }
                } else if (context.mounted) {
                  Navigator.pop(context);
                }
              } catch (e) {
                debugPrint('[TRIP] Cancel navigation error: $e');
                if (context.mounted) {
                  Navigator.pop(context);
                }
              }
            },
            child: const Text(
              'Yes, Cancel',
              style: TextStyle(color: Color(0xFFC65A5A)),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final rideProvider = Provider.of<RideProvider>(context);
    final driver = rideProvider.driver;
    final theme = Theme.of(context);

    // Authoritative route pushed by the backend (navigationStarted /
    // navigationRerouteRequested). Never re-planned from this screen —
    // that used to fire a routing API call every ~50 m of driver
    // movement.
    final navigationRoute = rideProvider.navigationRoute;
    final etaSec =
        rideProvider.driverEtaSeconds ?? rideProvider.navigationEtaSeconds;

    if (rideProvider.status == models.TripStatus.COMPLETED && !_dialogShown) {
      _dialogShown = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _showArrivalDialog();
      });
    }

    // First-class cancelled state (spec §30/§33): when the DRIVER ends the
    // ride, render who cancelled + why with a Report option, then exit once.
    // The rider's OWN cancel already resets via cancelRide()'s REST confirm,
    // so this only fires for the other party's cancellation.
    if (rideProvider.status == models.TripStatus.CANCELLED &&
        !_cancelledHandled) {
      _cancelledHandled = true;
      final currentTrip = rideProvider.currentTrip;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _handleRideCancelled(currentTrip);
      });
    }

    // Driver cancelled after acceptance: the backend released the SAME ride
    // back into normal search (REQUESTED). Apologize exactly once per
    // release, then hand the rider to the existing search experience — the
    // map screen's normal searching sheet re-attaches to this ride
    // automatically (RideProvider.isSearchingForDriver). This screen always
    // exits on REQUESTED: a rider here with a REQUESTED ride has an
    // accepted driver seat that no longer exists.
    if (rideProvider.status == models.TripStatus.REQUESTED &&
        !_driverReleasedHandled) {
      _driverReleasedHandled = true;
      final notice = rideProvider.driverCancelledNotice;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        if (notice != null) {
          _handleDriverReleased(rideProvider);
        } else {
          _returnToExplore();
        }
      });
    }

    if (driver == null) {
      // Stale deep link / notification tap into an already-finished trip:
      // without this the screen hung on "Securing your driver..." forever
      // (the provider is IDLE and no driver will ever arrive).
      if (rideProvider.status == models.TripStatus.IDLE ||
          rideProvider.currentTrip == null) {
        return _buildEndedTripScreen(theme);
      }
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
                  style: theme.textTheme.headlineMedium?.copyWith(
                    fontSize: 20,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  'Your premium vehicle is on its way.',
                  style: TextStyle(
                    color: const Color(0xFF2F3A32).withOpacity(0.5),
                    fontWeight: FontWeight.w500,
                  ),
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
        : LatLng(
            rideProvider.currentTrip!.pickup.lat,
            rideProvider.currentTrip!.pickup.lng,
          );

    // While follow mode is on, every fresh driver fix re-centers the map.
    if (_followDriver && _followDriverLocation != driverLocation) {
      _followDriverLocation = driverLocation;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_followDriver) return;
        _animateCameraTo(driverLocation);
      });
    }

    return Scaffold(
      body: Stack(
        children: [
          FlutterMap(
            mapController: _mapController,
            options: MapOptions(
              initialCenter: driverLocation,
              initialZoom: _defaultMapZoom,
              minZoom: 12,
              maxZoom: 18,
              // Rider map stays north-up: follow the driver's position,
              // never rotate the camera with the vehicle heading.
              interactionOptions: const InteractionOptions(
                flags: InteractiveFlag.all & ~InteractiveFlag.rotate,
              ),
              onMapReady: () {
                _isMapReady = true;
                final target = _followDriverLocation;
                if (_followDriver && target != null) {
                  _animateCameraTo(target);
                }
              },
              onPositionChanged: (_, hasGesture) {
                if (hasGesture) _stopFollowingDriver();
              },
            ),
            children: [
              TileLayer(
                urlTemplate:
                    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
                maxNativeZoom: 16,
                userAgentPackageName: 'com.NetRide.rider',
                tileBuilder: brandedMapTile,
              ),
              if (navigationRoute != null && navigationRoute.length >= 2)
                PolylineLayer(
                  polylines: [
                    Polyline(
                      points: navigationRoute,
                      color: const Color(0xFF5B7760),
                      strokeWidth: 4.0,
                    ),
                  ],
                ),
              MarkerLayer(
                markers: [
                  // Before pickup the rider and driver are apart, so both
                  // markers are meaningful. Once the trip is IN_PROGRESS they
                  // are in the same car: show ONLY the driver's moving marker
                  // instead of a redundant rider dot that can drift stale.
                  if (_riderLocation != null && rideProvider.isPrePickup)
                    Marker(
                      point: _riderLocation!,
                      width: 40,
                      height: 40,
                      child: Container(
                        decoration: BoxDecoration(
                          color: const Color(0xFF5B7760).withOpacity(0.2),
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(
                          Icons.person_pin_circle,
                          color: Color(0xFF5B7760),
                          size: 30,
                        ),
                      ),
                    ),
                  if (rideProvider.status == models.TripStatus.IN_PROGRESS)
                    Marker(
                      point: LatLng(
                        rideProvider.currentTrip!.destination.lat,
                        rideProvider.currentTrip!.destination.lng,
                      ),
                      width: 30,
                      height: 30,
                      child: const Icon(
                        Icons.location_on,
                        color: Color(0xFF2F3A32),
                        size: 30,
                      ),
                    ),
                ],
              ),
              SmoothDriverMarker(
                driverId: driver.id,
                position: driverLocation,
                heading: driver.location?.heading ?? 0,
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
                    BoxShadow(
                      color: Colors.black.withOpacity(0.08),
                      blurRadius: 20,
                      offset: const Offset(0, 10),
                    ),
                  ],
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    // Driver-connectivity watchdog (heartbeat lost mid-ride):
                    // an explicit "we're monitoring" state instead of a
                    // silently frozen marker. Clears automatically when the
                    // driver's app reports again.
                    if (rideProvider.driverOffline) ...[
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 10,
                        ),
                        decoration: BoxDecoration(
                          color: const Color(0xFFFFF4E5),
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(color: const Color(0xFFE8A33D)),
                        ),
                        child: const Row(
                          children: [
                            Icon(
                              Icons.wifi_off_rounded,
                              size: 16,
                              color: Color(0xFFB26A00),
                            ),
                            SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                "We lost your driver's connection — we're monitoring your ride. You can cancel if you need to.",
                                style: TextStyle(
                                  fontSize: 11.5,
                                  fontWeight: FontWeight.w600,
                                  color: Color(0xFF8A5A00),
                                  height: 1.3,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 12),
                    ],
                    Row(
                      children: [
                        // Assigned driver's public profile photo. Keyed by
                        // driver id so a rematch/cancellation can never leave
                        // the previous driver's image visible, and falls back
                        // to a neutral avatar while loading / on error.
                        _DriverAvatar(
                          key: ValueKey('driver-photo-${driver.id}'),
                          photoUrl: driver.photoUrl,
                        ),
                        const SizedBox(width: 16),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                rideProvider.status ==
                                        models.TripStatus.DRIVER_ARRIVING
                                    ? 'DRIVER HAS ARRIVED'
                                    : rideProvider.isPrePickup
                                    ? 'DRIVER IS ARRIVING'
                                    : 'TRIP IN PROGRESS',
                                style: const TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.w800,
                                  letterSpacing: 1,
                                  color: Color(0xFF5B7760),
                                ),
                              ),
                              Text(
                                driver.name.isNotEmpty
                                    ? driver.name
                                    : 'Your driver',
                                style: const TextStyle(
                                  fontSize: 18,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ],
                          ),
                        ),
                        if (driver.plate != null || driver.vehicle != null)
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              if (driver.plate != null)
                                Text(
                                  driver.plate!,
                                  style: const TextStyle(
                                    fontWeight: FontWeight.w800,
                                    fontSize: 14,
                                  ),
                                ),
                              if (driver.vehicle != null)
                                Text(
                                  driver.vehicle!,
                                  style: TextStyle(
                                    fontSize: 12,
                                    color: Colors.grey.shade600,
                                  ),
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

          // Center-on-driver control. Available while the driver is
          // approaching AND during the ride. Tapping follows the driver's
          // live position (north-up); panning/zooming opts out.
          if (rideProvider.isPrePickup ||
              rideProvider.status == models.TripStatus.IN_PROGRESS)
            Positioned(
              bottom: 292,
              right: 16,
              child: FloatingActionButton(
                heroTag: 'rider_trip_locate_fab',
                mini: true,
                backgroundColor: _followDriver
                    ? const Color(0xFF2F3A32)
                    : Colors.white,
                foregroundColor: _followDriver
                    ? Colors.white
                    : const Color(0xFF2F3A32),
                elevation: 4,
                shape: const CircleBorder(),
                tooltip: _followDriver
                    ? 'Following your driver'
                    : 'Follow your driver',
                onPressed: () => _startFollowingDriver(driverLocation),
                child: Icon(
                  _followDriver
                      ? Icons.my_location_rounded
                      : Icons.location_searching_rounded,
                  size: 22,
                ),
              ),
            ),

          // Tip FAB (during trip only, above the bottom controls)
          if (rideProvider.isPrePickup ||
              rideProvider.status == models.TripStatus.IN_PROGRESS)
            Positioned(
              bottom: 230,
              right: 16,
              child: TipFab(rideId: rideProvider.currentTrip!.id),
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
                borderRadius: const BorderRadius.vertical(
                  top: Radius.circular(32),
                ),
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
                      color: Colors.grey.shade200,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                  if (etaSec != null && etaSec > 0) ...[
                    const SizedBox(height: 16),
                    Row(
                      children: [
                        const Icon(
                          Icons.schedule,
                          color: Color(0xFF5B7760),
                          size: 16,
                        ),
                        const SizedBox(width: 6),
                        Text(
                          rideProvider.status ==
                                  models.TripStatus.DRIVER_ARRIVING
                              ? 'Waiting at pickup'
                              : rideProvider.isPrePickup
                              ? 'Arriving in ${(etaSec / 60).ceil()} min'
                              : 'ETA ${(etaSec / 60).ceil()} min',
                          style: const TextStyle(
                            color: Color(0xFF2F3A32),
                            fontSize: 13,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ],
                    ),
                  ],
                  const SizedBox(height: 24),
                  Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              rideProvider.isPrePickup
                                  ? 'PICKUP'
                                  : 'DESTINATION',
                              style: TextStyle(
                                fontSize: 10,
                                fontWeight: FontWeight.w800,
                                color: Colors.grey.shade400,
                                letterSpacing: 1,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              rideProvider.isPrePickup
                                  ? rideProvider.currentTrip!.pickup.address!
                                  : rideProvider
                                        .currentTrip!
                                        .destination
                                        .address!,
                              style: const TextStyle(
                                fontWeight: FontWeight.w600,
                                fontSize: 14,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 16),
                      _ChatCallButtons(
                        tripId: rideProvider.tripId ?? '',
                        peerName: driver.name.isNotEmpty
                            ? driver.name
                            : 'Your driver',
                      ),
                      // Ride actions live in a "⋯" menu on the far right
                      // instead of a full-width inline Cancel button.
                      if (rideProvider.isPrePickup ||
                          rideProvider.status ==
                              models.TripStatus.IN_PROGRESS) ...[
                        const SizedBox(width: 12),
                        _RideActionMenu(
                          onCancel: () =>
                              _showCancelDialog(context, rideProvider),
                        ),
                      ],
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
}

/// First-class "ride cancelled" dialog (spec §30/§33): shows who cancelled
/// and why, offers reporting regardless of who cancelled, then returns the
/// rider home.
class RideCancelledDialog extends StatelessWidget {
  final models.Trip? cancelledTrip;
  final bool isDriver;

  const RideCancelledDialog({
    super.key,
    required this.cancelledTrip,
    required this.isDriver,
  });

  static const Map<String, String> _driverCancelLabels = {
    'rider_not_at_pickup': 'Rider is not at pickup location',
    'rider_requested_cancel': 'Rider requested cancellation',
    'unsafe_pickup': 'Unsafe pickup location',
    'vehicle_issue': 'Vehicle issue',
    'emergency': 'Emergency',
    'unable_to_complete': 'Unable to complete the ride',
    'rider_behavior': 'Rider behavior/problem',
    'other': 'Another reason',
  };

  String get _reasonLabel {
    final trip = cancelledTrip;
    final code = trip?.cancellationReasonCode;
    final text = trip?.cancellationReasonText;
    if (code == 'other' && text != null && text.isNotEmpty) return text;
    if (code != null) {
      final label = _driverCancelLabels[code];
      if (label != null) return label;
    }
    return text ?? 'No reason provided';
  }

  @override
  Widget build(BuildContext context) {
    final cancelled = cancelledTrip;
    final heading = cancelled == null
        ? 'You cancelled this ride'
        : 'Your driver cancelled this ride';
    final body = cancelled == null
        ? 'The ride has been cancelled. You can request a new one anytime.'
        : 'Reason: $_reasonLabel';

    return AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
      backgroundColor: Colors.white,
      title: Center(
        child: Column(
          children: [
            Icon(
              cancelled == null ? Icons.close_rounded : Icons.cancel_outlined,
              size: 40,
              color: const Color(0xFF5B7760),
            ),
            const SizedBox(height: 12),
            const Text(
              'Ride Cancelled',
              style: TextStyle(
                fontWeight: FontWeight.w900,
                fontSize: 22,
                color: Color(0xFF2F3A32),
              ),
            ),
          ],
        ),
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            heading,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w700,
              color: Color(0xFF2F3A32),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            body,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 13,
              color: Colors.grey,
              height: 1.4,
            ),
          ),
        ],
      ),
      actionsAlignment: MainAxisAlignment.center,
      actions: [
        if (cancelled != null) ...[
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: () {
                Navigator.pop(context);
                showModalBottomSheet<bool>(
                  context: context,
                  backgroundColor: Colors.white,
                  shape: const RoundedRectangleBorder(
                    borderRadius: BorderRadius.vertical(
                      top: Radius.circular(24),
                    ),
                  ),
                  isScrollControlled: true,
                  builder: (_) => ReportSheet(rideId: cancelled.id),
                );
              },
              icon: const Icon(
                Icons.report_gmailerrorred_outlined,
                size: 18,
                color: Color(0xFFC65A5A),
              ),
              label: Text(
                'Report ${isDriver ? 'Driver' : 'Rider'}',
                style: const TextStyle(
                  fontWeight: FontWeight.w700,
                  height: 1.25,
                ),
              ),
              style: OutlinedButton.styleFrom(
                padding: const EdgeInsets.symmetric(
                  vertical: 14,
                  horizontal: 16,
                ),
                minimumSize: const Size(0, 48),
                textStyle: const TextStyle(fontSize: 15, height: 1.25),
              ),
            ),
          ),
          const SizedBox(height: 8),
        ],
        SizedBox(
          width: double.infinity,
          child: ElevatedButton(
            onPressed: () => Navigator.pop(context),
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF2F3A32),
              foregroundColor: Colors.white,
              padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 16),
              minimumSize: const Size(0, 48),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(14),
              ),
              textStyle: const TextStyle(fontSize: 15, height: 1.25),
            ),
            child: const Text(
              'Done',
              style: TextStyle(fontWeight: FontWeight.w800, height: 1.25),
            ),
          ),
        ),
      ],
    );
  }
}

class _ArrivalSummaryDialog extends StatefulWidget {
  final models.Trip trip;
  const _ArrivalSummaryDialog({required this.trip});

  @override
  State<_ArrivalSummaryDialog> createState() => _ArrivalSummaryDialogState();
}

class _ArrivalSummaryDialogState extends State<_ArrivalSummaryDialog> {
  late final ConfettiController _confettiController;

  @override
  void initState() {
    super.initState();
    _confettiController = ConfettiController(
      duration: const Duration(seconds: 3),
    );
    _confettiController.play();
  }

  @override
  void dispose() {
    _confettiController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final finalFare = widget.trip.fareAmount ?? 0.0;
    final rewardCents = widget.trip.rideCreditRewardCents ?? 0;
    final balanceCents = widget.trip.rideCreditBalanceCents;

    return PopScope(
      canPop: false,
      child: Stack(
        alignment: Alignment.topCenter,
        children: [
          ModalBarrier(
            color: Colors.black.withOpacity(0.54),
            dismissible: false,
          ),
          Center(
            child: Container(
              margin: const EdgeInsets.symmetric(horizontal: 32),
              decoration: BoxDecoration(
                color: const Color(0xFFF7F4EF),
                borderRadius: BorderRadius.circular(28),
                border: Border.all(color: const Color(0xFFD8D2CA), width: 1),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withOpacity(0.25),
                    blurRadius: 20,
                    offset: const Offset(0, 10),
                  ),
                ],
              ),
              padding: const EdgeInsets.all(28),
              child: Material(
                color: Colors.transparent,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 100,
                      height: 100,
                      decoration: const BoxDecoration(
                        shape: BoxShape.circle,
                        color: Color(0xFF5B7760),
                      ),
                      child: const Center(
                        child: Icon(
                          Icons.check_rounded,
                          size: 60,
                          color: Colors.white,
                        ),
                      ),
                    ),
                    const SizedBox(height: 24),
                    const Text(
                      'Congratulations!',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: Color(0xFF2F3A32),
                        fontSize: 22,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    if (rewardCents > 0) ...[
                      const SizedBox(height: 12),
                      Text(
                        'You earned \$${(rewardCents / 100).toStringAsFixed(2)} in ride credits',
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          color: Color(0xFF2F3A32),
                          fontSize: 18,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      const SizedBox(height: 12),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 16,
                          vertical: 8,
                        ),
                        decoration: BoxDecoration(
                          color: const Color(0xFF6E8B74).withOpacity(0.15),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(
                            color: const Color(0xFF6E8B74).withOpacity(0.3),
                          ),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(
                              Icons.savings_outlined,
                              color: Color(0xFF5B7760),
                              size: 20,
                            ),
                            const SizedBox(width: 8),
                            Flexible(
                              child: Text(
                                balanceCents != null
                                    ? 'Added! New balance: \$${(balanceCents / 100).toStringAsFixed(2)}'
                                    : 'Added to your ride credits',
                                style: const TextStyle(
                                  color: Color(0xFF5B7760),
                                  fontWeight: FontWeight.bold,
                                  fontSize: 14,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ] else ...[
                      const SizedBox(height: 12),
                      const Text(
                        'Your trip is complete.',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: Color(0xFF2F3A32),
                          fontSize: 18,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ],
                    const SizedBox(height: 20),
                    Text(
                      'Final fare: \$${finalFare.toStringAsFixed(2)}',
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        color: Color(0xFF2F3A32),
                      ),
                    ),
                    const SizedBox(height: 28),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton(
                        onPressed: () async {
                          final rideProvider = Provider.of<RideProvider>(
                            context,
                            listen: false,
                          );
                          final trip = rideProvider.currentTrip;
                          rideProvider.reset();
                          try {
                            final nav = Navigator.of(
                              context,
                              rootNavigator: true,
                            );
                            nav.pop(); // Close the arrival dialog
                            if (trip != null) {
                              // A completed SPECIAL ride pops the validation
                              // code card right away: the rider must show
                              // this code inside the deal place to get their
                              // deal back (card refund or a little extra in
                              // ride credits). They can close it for now —
                              // the Explore "SPECIAL CODES" card keeps it
                              // handy.
                              final specials = Provider.of<SpecialsProvider>(
                                context,
                                listen: false,
                              );
                              final readyId = specials.consumeReadyNotice();
                              if (readyId != null) {
                                final card = specials.pending
                                    .where((e) => e.id == readyId)
                                    .toList();
                                if (card.isNotEmpty) {
                                  final r = card.first;
                                  await showDialog<void>(
                                    context: nav.context,
                                    barrierDismissible: false,
                                    builder: (_) => SpecialReadyDialog(
                                      redemption: r,
                                      code: specials.codeFor(r.id),
                                    ),
                                  );
                                }
                              }
                              if (!nav.context.mounted) return;
                              nav.pushReplacement(
                                MaterialPageRoute(
                                  builder: (_) => RatingScreen(trip: trip),
                                ),
                              );
                            } else {
                              nav.pop();
                            }
                          } catch (e) {
                            debugPrint(
                              '[ARRIVAL] Navigation error after reset: $e',
                            );
                          }
                        },
                        style: ElevatedButton.styleFrom(
                          backgroundColor: const Color(0xFF5B7760),
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(16),
                          ),
                          padding: const EdgeInsets.symmetric(vertical: 16),
                        ),
                        child: const Text(
                          'RATE YOUR TRIP',
                          style: TextStyle(
                            fontWeight: FontWeight.bold,
                            fontSize: 16,
                            letterSpacing: 0.5,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          ConfettiWidget(
            confettiController: _confettiController,
            blastDirectionality: BlastDirectionality.explosive,
            shouldLoop: false,
            colors: const [Color(0xFF5B7760), Color(0xFFE5A93B), Colors.white],
          ),
        ],
      ),
    );
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

  /// Native phone dialing (spec §17–§19): the driver's authoritative phone
  /// number comes from the backend users table (party-only) and the device
  /// dialer opens via tel:. No in-app/VoIP calling surface.
  Future<void> _startCall(BuildContext context) async {
    if (!context.mounted) return;
    try {
      final response = await ApiService.dio.get('/ride/$tripId/party-phone');
      final phone = response.data['phone_number']?.toString();
      if (phone == null || phone.trim().isEmpty) {
        _showSnack(context, 'Unable to call this user.');
        return;
      }
      final uri = Uri(scheme: 'tel', path: phone.trim());
      final launched = await launchUrl(
        uri,
        mode: LaunchMode.externalApplication,
      );
      if (!launched) {
        _showSnack(context, 'Unable to open the phone app.');
      }
    } on DioException catch (e) {
      String? serverMsg;
      if (e.response?.data is Map) {
        serverMsg = (e.response!.data as Map)['error']?.toString();
      }
      _showSnack(context, serverMsg ?? 'Unable to call this user.');
    } catch (e) {
      debugPrint('[TRIP] Dial failed: $e');
      _showSnack(context, 'Unable to open the phone app.');
    }
  }

  void _showSnack(BuildContext context, String message) {
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), behavior: SnackBarBehavior.floating),
    );
  }

  Future<String?> _readUserId() async {
    return SecureTokenStore.userId;
  }

  @override
  Widget build(BuildContext context) {
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
          tooltip: 'Call driver',
          onPressed: () => _startCall(context),
          icon: const Icon(Icons.phone_outlined, color: Color(0xFF2F3A32)),
          style: IconButton.styleFrom(
            backgroundColor: const Color(0xFFF7F4EF),
            padding: const EdgeInsets.all(12),
          ),
        ),
      ],
    );
  }
}

/// Compact "⋯" ride actions menu shown on the far right of the bottom
/// controls. Holds the Cancel Ride action — mirrors the driver app.
class _RideActionMenu extends StatelessWidget {
  final VoidCallback onCancel;

  const _RideActionMenu({required this.onCancel});

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<String>(
      tooltip: 'Ride actions',
      color: Colors.white,
      elevation: 4,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      offset: const Offset(0, -64),
      onSelected: (value) {
        if (value == 'cancel') onCancel();
      },
      itemBuilder: (context) => [
        const PopupMenuItem(
          value: 'cancel',
          child: Row(
            children: [
              Icon(Icons.cancel_outlined, size: 20, color: Color(0xFFC65A5A)),
              SizedBox(width: 10),
              Text(
                'Cancel Ride',
                style: TextStyle(
                  fontWeight: FontWeight.w600,
                  color: Color(0xFF2F3A32),
                ),
              ),
            ],
          ),
        ),
      ],
      child: Container(
        decoration: BoxDecoration(
          color: const Color(0xFFF7F4EF),
          borderRadius: BorderRadius.circular(50),
        ),
        padding: const EdgeInsets.all(12),
        child: const Icon(
          Icons.more_horiz_rounded,
          size: 22,
          color: Color(0xFF2F3A32),
        ),
      ),
    );
  }
}

/// Assigned driver's profile photo with a light-green placeholder while
/// loading and a neutral fallback avatar when the image cannot be loaded.
class _DriverAvatar extends StatelessWidget {
  final String? photoUrl;

  const _DriverAvatar({super.key, this.photoUrl});

  static const double _size = 52;

  @override
  Widget build(BuildContext context) {
    final url = photoUrl;
    return SizedBox(
      width: _size,
      height: _size,
      child: ClipOval(
        child: (url != null && url.isNotEmpty)
            ? Image.network(
                resolveFileUrl(url),
                width: _size,
                height: _size,
                fit: BoxFit.cover,
                loadingBuilder: (context, child, progress) {
                  if (progress == null) return child;
                  return const _DriverAvatarPlaceholder();
                },
                errorBuilder: (_, __, ___) => const _DriverAvatarPlaceholder(),
              )
            : const _DriverAvatarPlaceholder(),
      ),
    );
  }
}

class _DriverAvatarPlaceholder extends StatelessWidget {
  const _DriverAvatarPlaceholder();

  @override
  Widget build(BuildContext context) {
    return Container(
      color: const Color(0xFFE8F1E9),
      alignment: Alignment.center,
      child: const Icon(
        Icons.person_rounded,
        color: Color(0xFF5B7760),
        size: 26,
      ),
    );
  }
}
