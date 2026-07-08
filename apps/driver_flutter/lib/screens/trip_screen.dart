import 'dart:async';
import 'package:flutter/material.dart';
import 'package:latlong2/latlong.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../providers/driver_provider.dart';
import '../models/trip_models.dart' as models;
import '../services/navigation_service.dart';
import '../services/communication_service.dart';
import '../services/sound_service.dart';
import '../components/trip_completed_dialog.dart';
import '../components/state_container.dart';
import 'navigation_screen.dart';
import 'chat_sheet.dart';
import 'call_overlay.dart';

class TripScreen extends StatefulWidget {
  const TripScreen({super.key});

  @override
  State<TripScreen> createState() => _TripScreenState();
}

class _TripScreenState extends State<TripScreen> {
  ViewState _state = ViewState.loading;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _initNavigation());
  }

  Future<void> _initNavigation() async {
    setState(() => _state = ViewState.loading);
    try {
      final driverProvider =
          Provider.of<DriverProvider>(context, listen: false);
      final navService =
          Provider.of<NavigationService>(context, listen: false);
      final trip = driverProvider.currentTrip;

      if (trip == null) {
        setState(() {
          _state = ViewState.failure;
          _errorMessage = 'Active trip data not found. Returning to dashboard...';
        });
        Future.delayed(const Duration(seconds: 2), () {
          if (mounted && Navigator.canPop(context)) {
            Navigator.pop(context);
          }
        });
        return;
      }

      final start = driverProvider.lastLocation != null
          ? LatLng(driverProvider.lastLocation!.lat,
              driverProvider.lastLocation!.lng)
          : LatLng(trip.pickup.lat, trip.pickup.lng);

      final leg = trip.status == models.TripStatus.ACCEPTED
          ? NavigationLeg.pickup
          : NavigationLeg.destination;

      final end = leg == NavigationLeg.pickup
          ? LatLng(trip.pickup.lat, trip.pickup.lng)
          : LatLng(trip.destination.lat, trip.destination.lng);

      await navService.startNavigation(
        tripId: trip.id,
        leg: leg,
        start: start,
        end: end,
      );

      if (mounted) setState(() => _state = ViewState.success);
    } catch (e) {
      setState(() {
        _state = ViewState.failure;
        _errorMessage =
            'Could not calculate the optimal route. Please verify your GPS signal.';
      });
    }
  }

  void _swapLeg(NavigationLeg newLeg, models.Trip trip) async {
    final driverProvider =
        Provider.of<DriverProvider>(context, listen: false);
    final navService =
        Provider.of<NavigationService>(context, listen: false);

    final start = driverProvider.lastLocation != null
        ? LatLng(driverProvider.lastLocation!.lat,
            driverProvider.lastLocation!.lng)
        : LatLng(trip.pickup.lat, trip.pickup.lng);
    final end = newLeg == NavigationLeg.pickup
        ? LatLng(trip.pickup.lat, trip.pickup.lng)
        : LatLng(trip.destination.lat, trip.destination.lng);

    await navService.startNavigation(
      tripId: trip.id,
      leg: newLeg,
      start: start,
      end: end,
    );
  }

  @override
  Widget build(BuildContext context) {
    final driverProvider = Provider.of<DriverProvider>(context);
    final navService = Provider.of<NavigationService>(context);
    final trip = driverProvider.currentTrip;
    final theme = Theme.of(context);

    return Scaffold(
      body: StateContainer(
        state: _state,
        errorMessage: _errorMessage,
        onRetry: _initNavigation,
        loadingWidget: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const CircularProgressIndicator(color: Color(0xFF2F3A32)),
              const SizedBox(height: 32),
              Text(
                'Establishing Secure Route...',
                style: theme.textTheme.headlineSmall
                    ?.copyWith(fontSize: 18, fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 12),
              Text(
                'Preparing professional navigation.',
                style: TextStyle(
                    color: Colors.black.withOpacity(0.5),
                    fontWeight: FontWeight.w500),
              ),
            ],
          ),
        ),
        successWidget: trip == null
            ? const SizedBox()
            : _buildNavigation(trip, driverProvider, navService),
      ),
    );
  }

  Widget _buildNavigation(
    models.Trip trip,
    DriverProvider driverProvider,
    NavigationService navService,
  ) {
    // Keep the NavigationService's leg in sync with the trip status.
    // Accept → pickup, InProgress → destination.
    final desiredLeg = trip.status == models.TripStatus.ACCEPTED
        ? NavigationLeg.pickup
        : NavigationLeg.destination;
    if (navService.leg != desiredLeg && navService.isNavigating) {
      WidgetsBinding.instance
          .addPostFrameCallback((_) => _swapLeg(desiredLeg, trip));
    }

    return Stack(
      children: [
        NavigationScreen(
          canPickupRider:
              _isActionInRange(trip, driverProvider, isPickup: true),
          canCompleteTrip:
              _isActionInRange(trip, driverProvider, isPickup: false),
          pickupAddress: trip.pickup.address ?? 'Pickup',
          destinationAddress: trip.destination.address ?? 'Destination',
          onPickupRider: () => driverProvider.pickUpRider(trip.id),
          onCompleteTrip: _showRiderRatingDialog,
          onChat: () => _openChat(context, trip),
          onCall: () => _startCall(context, trip),
        ),
        const DriverCallOverlayHost(),
        if (!_isActionInRange(trip, driverProvider,
            isPickup: trip.status == models.TripStatus.ACCEPTED))
          Positioned(
            bottom: 200,
            left: 20,
            right: 20,
            child: IgnorePointer(
              ignoring: true,
              child: Container(
                padding: const EdgeInsets.symmetric(
                    horizontal: 14, vertical: 10),
                decoration: BoxDecoration(
                  color: const Color(0xFFC65A5A).withOpacity(0.92),
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Text(
                  _outOfRangeHint(trip, driverProvider),
                  style: const TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.w600,
                    fontSize: 13,
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }

  void _showRiderRatingDialog() {
    final driverProvider = Provider.of<DriverProvider>(context, listen: false);
    final trip = driverProvider.currentTrip;
    if (trip == null) return;

    if (trip.isTestTrip) {
      SoundService.instance.play(SoundEffect.tripCompleted);
      driverProvider.completeTrip(trip.id);
      showDialog(
        context: context,
        barrierDismissible: false,
        builder: (context) => TripCompletedDialog(
          fareAmount: trip.fareAmount ?? 0.0,
          tipAmount: 0.0,
          isDriver: true,
        ),
      ).then((_) {
        if (mounted) Navigator.pop(context);
      });
      return;
    }

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
          shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(24)),
          title: const Text(
            'Rate your Rider',
            style: TextStyle(
                fontWeight: FontWeight.w700,
                fontSize: 20,
                color: Color(0xFF2F3A32)),
            textAlign: TextAlign.center,
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'How was your experience with this rider?',
                style: TextStyle(
                    fontSize: 14,
                    color: const Color(0xFF2F3A32).withOpacity(0.7)),
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
                    onPressed: () =>
                        setState(() => selectedRating = index + 1),
                  );
                }),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: reviewController,
                maxLines: 2,
                decoration: InputDecoration(
                  hintText: 'Add a comment (optional)',
                  hintStyle: TextStyle(
                      fontSize: 13,
                      color: const Color(0xFF2F3A32).withOpacity(0.4)),
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
                onPressed: isSubmitting
                    ? null
                    : () async {
                        setState(() => isSubmitting = true);
                        final driverProvider =
                            Provider.of<DriverProvider>(context,
                                listen: false);
                        try {
                          if (driverProvider.currentTrip != null) {
                            final trip = driverProvider.currentTrip!;
                            await driverProvider.rateRide(
                              trip.id,
                              selectedRating,
                              reviewController.text.trim(),
                            );
                            SoundService.instance.play(SoundEffect.tripCompleted);
                            driverProvider.completeTrip(trip.id);
                            if (mounted) {
                              Navigator.pop(context);
                              await showDialog(
                                context: context,
                                barrierDismissible: false,
                                builder: (context) => TripCompletedDialog(
                                  fareAmount: trip.fareAmount ?? 0.0,
                                  tipAmount: 0.0,
                                  isDriver: true,
                                ),
                              );
                            }
                          }
                          if (mounted) Navigator.pop(context);
                        } catch (e) {
                          if (mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(
                                    content: Text(
                                        'Failed to submit rating: $e')));
                            setState(() => isSubmitting = false);
                          }
                        }
                      },
                child: isSubmitting
                    ? const SizedBox(
                        height: 20,
                        width: 20,
                        child: CircularProgressIndicator(
                            color: Colors.white, strokeWidth: 2))
                    : const Text('SUBMIT & FINISH'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ---- Proximity helpers ------------------------------------------------

  static const double kPickupProximityM = 15;
  static const double kDestinationProximityM = 30;

  double _metersFromDriverTo(LatLng target, DriverProvider provider) {
    final loc = provider.lastLocation;
    if (loc == null) return double.infinity;
    return const Distance().as(
      LengthUnit.Meter,
      LatLng(loc.lat, loc.lng),
      target,
    );
  }

  bool _isActionInRange(
    models.Trip trip,
    DriverProvider provider, {
    required bool isPickup,
  }) {
    if (isPickup) {
      return _metersFromDriverTo(
            LatLng(trip.pickup.lat, trip.pickup.lng),
            provider,
          ) <=
          kPickupProximityM;
    }
    return _metersFromDriverTo(
          LatLng(trip.destination.lat, trip.destination.lng),
          provider,
        ) <=
        kDestinationProximityM;
  }

  String _outOfRangeHint(models.Trip trip, DriverProvider provider) {
    final loc = provider.lastLocation;
    if (loc == null) return 'Waiting for GPS signal...';
    final isPickup = trip.status == models.TripStatus.ACCEPTED;
    final m = _metersFromDriverTo(
      isPickup
          ? LatLng(trip.pickup.lat, trip.pickup.lng)
          : LatLng(trip.destination.lat, trip.destination.lng),
      provider,
    );
    final ft = (m * 3.281).round();
    return isPickup
        ? 'Drive closer to pickup — $ft ft away'
        : 'Drive closer to destination — $ft ft away';
  }

  // ---- In-trip chat + masked call helpers --------------------------------

  Future<String?> _readUserId() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('user_id');
  }

  Future<void> _openChat(BuildContext context, models.Trip trip) async {
    final driverProvider = Provider.of<DriverProvider>(context, listen: false);
    final comm = context.read<CommunicationService>();
    final driverId = await _readUserId();
    await comm.attachAndLoad(
      socket: driverProvider.socket,
      userId: driverId,
      tripId: trip.id,
      peerName: trip.riderInfo?.name ?? 'Your rider',
    );
    if (!context.mounted) return;
    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => ChatSheet(
        tripId: trip.id,
        peerName: comm.peerName ?? trip.riderInfo?.name ?? 'Your rider',
      ),
    );
  }

  Future<void> _startCall(BuildContext context, models.Trip trip) async {
    final driverProvider = Provider.of<DriverProvider>(context, listen: false);
    final comm = context.read<CommunicationService>();
    final driverId = await _readUserId();
    await comm.attachAndLoad(
      socket: driverProvider.socket,
      userId: driverId,
      tripId: trip.id,
      peerName: trip.riderInfo?.name ?? 'Your rider',
    );
    if (!context.mounted) return;
    final ok = await comm.startCall();
    if (!ok && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(comm.lastError ?? 'Call failed.')),
      );
    }
  }
}

/// Surfaces the CallOverlay when the driver has an active or ringing
/// call, so it can pop on top of the navigation map.
class DriverCallOverlayHost extends StatelessWidget {
  const DriverCallOverlayHost({super.key});

  @override
  Widget build(BuildContext context) {
    return Consumer<CommunicationService>(
      builder: (context, comm, _) {
        if (comm.callPhase == CallPhase.idle) return const SizedBox.shrink();
        return Positioned.fill(child: CallOverlay(peerName: comm.peerName ?? 'Rider'));
      },
    );
  }
}