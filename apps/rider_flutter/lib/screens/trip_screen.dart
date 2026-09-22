import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:geolocator/geolocator.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';
import '../providers/ride_provider.dart';
import '../models/trip_models.dart' as models;
import '../services/communication_service.dart';
import '../services/api_service.dart';
import '../services/location_reporter.dart';
import '../components/smooth_driver_marker.dart';
import '../components/state_container.dart';
import '../components/tip_fab.dart';
import '../components/driver_cancelled_dialog.dart';
import 'rating_screen.dart';
import 'chat_sheet.dart';
import 'report_sheet.dart';

class TripScreen extends StatefulWidget {
  const TripScreen({super.key});

  @override
  State<TripScreen> createState() => _TripScreenState();
}

class _TripScreenState extends State<TripScreen> {
  final MapController _mapController = MapController();
  LatLng? _riderLocation;
  StreamSubscription<Position>? _positionSubscription;
  bool _dialogShown = false;

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
          setState(() {
            _riderLocation = LatLng(position.latitude, position.longitude);
          });
          _locationReporter.report(position.latitude, position.longitude);
        });
  }

  @override
  void dispose() {
    _positionSubscription?.cancel();
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

    final prefs = await SharedPreferences.getInstance();
    final ownId = prefs.getString('user_id');
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

    return Scaffold(
      body: Stack(
        children: [
          FlutterMap(
            mapController: _mapController,
            options: MapOptions(
              initialCenter: driverLocation,
              initialZoom: 15.0,
              minZoom: 12,
              maxZoom: 18,
              onMapReady: () {},
            ),
            children: [
              TileLayer(
                urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                userAgentPackageName: 'com.NetRide.rider',
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
                    Row(
                      children: [
                        const CircleAvatar(
                          backgroundColor: Color(0xFFF7F4EF),
                          child: Icon(
                            Icons.local_taxi,
                            color: Color(0xFF5B7760),
                          ),
                        ),
                        const SizedBox(width: 16),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                rideProvider.status ==
                                        models.TripStatus.ACCEPTED
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

          // Tip FAB (during trip only, above the bottom controls)
          if (rideProvider.status == models.TripStatus.ACCEPTED ||
              rideProvider.status == models.TripStatus.IN_PROGRESS)
            Positioned(
              bottom: 210,
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
                          rideProvider.status == models.TripStatus.ACCEPTED
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
                              rideProvider.status == models.TripStatus.ACCEPTED
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
                              rideProvider.status == models.TripStatus.ACCEPTED
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
                      if (rideProvider.status == models.TripStatus.ACCEPTED ||
                          rideProvider.status == models.TripStatus.IN_PROGRESS)
                        TextButton.icon(
                          onPressed: () =>
                              _showCancelDialog(context, rideProvider),
                          icon: const Icon(
                            Icons.close,
                            color: Color(0xFFC65A5A),
                            size: 18,
                          ),
                          label: const Text(
                            'Cancel',
                            style: TextStyle(
                              color: Color(0xFFC65A5A),
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      _ChatCallButtons(
                        tripId: rideProvider.tripId ?? '',
                        peerName: driver.name.isNotEmpty
                            ? driver.name
                            : 'Your driver',
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
            height: 46,
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
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
            ),
          ),
          const SizedBox(height: 8),
        ],
        SizedBox(
          width: double.infinity,
          height: 46,
          child: ElevatedButton(
            onPressed: () => Navigator.pop(context),
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF2F3A32),
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(14),
              ),
            ),
            child: const Text(
              'Done',
              style: TextStyle(fontWeight: FontWeight.w800),
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
  @override
  Widget build(BuildContext context) {
    final finalFare = widget.trip.fareAmount ?? 0.0;

    return AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(28)),
      backgroundColor: Colors.white,
      title: const Center(
        child: Text(
          'You have arrived! 🎉',
          style: TextStyle(
            fontWeight: FontWeight.w900,
            fontSize: 22,
            color: Color(0xFF2F3A32),
          ),
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
          Text(
            '\$${finalFare.toStringAsFixed(2)}',
            style: const TextStyle(
              fontSize: 38,
              fontWeight: FontWeight.w900,
              color: Color(0xFF2F3A32),
            ),
          ),
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
              final rideProvider = Provider.of<RideProvider>(
                context,
                listen: false,
              );
              final trip = rideProvider.currentTrip;
              rideProvider.reset();
              try {
                Navigator.pop(context); // Close dialog
                if (trip != null) {
                  Navigator.pushReplacement(
                    context,
                    MaterialPageRoute(
                      builder: (context) => RatingScreen(trip: trip),
                    ),
                  );
                } else {
                  Navigator.pop(context);
                }
              } catch (e) {
                debugPrint('[ARRIVAL] Navigation error after reset: $e');
              }
            },
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF2F3A32),
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(16),
              ),
            ),
            child: const Text(
              'RATE YOUR TRIP',
              style: TextStyle(fontWeight: FontWeight.bold, letterSpacing: 0.5),
            ),
          ),
        ),
      ],
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
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('user_id');
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
