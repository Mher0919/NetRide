import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:latlong2/latlong.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';
import '../providers/driver_provider.dart';
import '../models/trip_models.dart' as models;
import '../services/api_service.dart';
import '../services/navigation_service.dart';
import '../services/communication_service.dart';
import '../services/sound_service.dart';
import '../services/route_errors.dart';
import '../services/navigation_voice_service.dart';
import '../components/trip_completed_dialog.dart';
import '../components/state_container.dart';
import 'navigation_screen.dart';
import 'chat_sheet.dart';
import 'report_sheet.dart';

class TripScreen extends StatefulWidget {
  const TripScreen({super.key});

  /// True while a TripScreen is in the navigator stack. Guards the
  /// availability screen's auto-push so a late tripUpdate cannot push a
  /// SECOND trip screen on top of the chat sheet / cancel dialog (which
  /// used to re-run navigation and throw the driver back to the loading
  /// state mid-action).
  static bool isOpen = false;

  @override
  State<TripScreen> createState() => _TripScreenState();
}

class _TripScreenState extends State<TripScreen> {
  ViewState _state = ViewState.loading;
  String? _errorMessage;

  /// Guards: single cancellation dialog + single cancellation-failure
  /// notification per ride (spec §27/§40 — exactly one nav owner).
  bool _cancelledDialogShown = false;
  bool _cancelFailureNotified = false;
  bool _phantomRollbackNotified = false;
  bool _tripEverConfirmed = false;
  bool _completionNavStopped = false;

  @override
  void initState() {
    super.initState();
    TripScreen.isOpen = true;
    WidgetsBinding.instance.addPostFrameCallback((_) => _initNavigation());
  }

  @override
  void dispose() {
    TripScreen.isOpen = false;
    super.dispose();
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

      // Validate pickup coordinates before proceeding
      final pickupError = RouteValidator.validateDestination(trip.pickup.lat, trip.pickup.lng);
      if (pickupError != null) {
        setState(() {
          _state = ViewState.failure;
          _errorMessage = pickupError.userFacingMessage;
        });
        return;
      }

      // If trip is IN_PROGRESS, also validate destination
      if (trip.status == models.TripStatus.IN_PROGRESS) {
        final destError = RouteValidator.validateDestination(trip.destination.lat, trip.destination.lng);
        if (destError != null) {
          setState(() {
            _state = ViewState.failure;
            _errorMessage = destError.userFacingMessage;
          });
          return;
        }
      }

      // On first load, always start with the pickup leg regardless of trip
      // status. The trip's status may still be REQUESTED from the optimistic
      // acceptTrip update if the ACCEPTED tripUpdate hasn't arrived yet.
      // Navigation only switches to destination when trip goes IN_PROGRESS —
      // never route to destination for REQUESTED/ACCEPTED (a stale
      // `isNavigating` from a previous trip must not skip the pickup leg).
      final leg = trip.status == models.TripStatus.IN_PROGRESS
          ? NavigationLeg.destination
          : NavigationLeg.pickup;

      final end = leg == NavigationLeg.pickup
          ? LatLng(trip.pickup.lat, trip.pickup.lng)
          : LatLng(trip.destination.lat, trip.destination.lng);

      // Validate driver location freshness
      final lastLoc = driverProvider.lastLocation;
      LatLng start;
      if (lastLoc != null) {
        start = LatLng(lastLoc.lat, lastLoc.lng);
      } else {
        // No driver location available - use pickup as origin
        // (the navigation service will compute route from driver once GPS is available)
        start = LatLng(trip.pickup.lat, trip.pickup.lng);
      }

      await navService.startNavigation(
        tripId: trip.id,
        leg: leg,
        start: start,
        end: end,
      );

      if (mounted) setState(() => _state = ViewState.success);
    } on RouteError catch (e) {
      setState(() {
        _state = ViewState.failure;
        _errorMessage = e.userFacingMessage;
      });
    } catch (e) {
      // Map known exception types to route errors.
      final routeError = _classifyError(e);
      setState(() {
        _state = ViewState.failure;
        _errorMessage = routeError.userFacingMessage;
      });
    }
  }

  RouteError _classifyError(Object error) {
    if (error is RouteError) return error;

    final msg = error.toString().toLowerCase();

    if (msg.contains('timeout') || msg.contains('timed out')) {
      return const RouteError(
        category: RouteErrorCategory.timeout,
        message: 'Route request timed out',
        isRetryable: true,
        isTransient: true,
      );
    }
    if (msg.contains('socket') || msg.contains('network') || msg.contains('connection')) {
      return const RouteError(
        category: RouteErrorCategory.networkError,
        message: 'Network error during routing',
        isRetryable: true,
        isTransient: true,
      );
    }
    if (msg.contains('401') || msg.contains('unauthorized') || msg.contains('403') || msg.contains('forbidden')) {
      return const RouteError(
        category: RouteErrorCategory.apiAuthentication,
        message: 'API authentication failed',
      );
    }
    if (msg.contains('429') || msg.contains('too many requests') || msg.contains('rate limit')) {
      return const RouteError(
        category: RouteErrorCategory.rateLimited,
        message: 'Rate limited',
        isRetryable: true,
        isTransient: true,
      );
    }
    if (msg.contains('402') || msg.contains('quota') || msg.contains('billing')) {
      return const RouteError(
        category: RouteErrorCategory.apiQuota,
        message: 'API quota exceeded',
      );
    }
    if (msg.contains('no route') || msg.contains('not found') || msg.contains('ZERO_RESULTS')) {
      return const RouteError(
        category: RouteErrorCategory.noRouteFound,
        message: 'No route found',
      );
    }
    if (msg.contains('gps') || msg.contains('location') && (msg.contains('unavail') || msg.contains('disabled') || msg.contains('denied'))) {
      return const RouteError(
        category: RouteErrorCategory.locationUnavailable,
        message: 'GPS location unavailable',
        isRetryable: true,
        isTransient: true,
      );
    }
    if (msg.contains('cancel')) {
      return const RouteError(
        category: RouteErrorCategory.routeCancelled,
        message: 'Route cancelled',
      );
    }

    return const RouteError(
      category: RouteErrorCategory.unknown,
      message: 'Unknown route error',
      isRetryable: true,
      isTransient: true,
    );
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
    final cancelledTrip = driverProvider.lastCancelledTrip;
    final theme = Theme.of(context);

    // Track whether this ride was ever server-confirmed (ACCEPTED or
    // IN_PROGRESS). The COMPLETED/CANCELLED paths null out currentTrip on
    // purpose — only an UNCONFIRMED trip that disappears is a phantom
    // accept that must be rolled back to the dashboard.
    if (trip != null &&
        (trip.status == models.TripStatus.ACCEPTED ||
            trip.status == models.TripStatus.IN_PROGRESS)) {
      _tripEverConfirmed = true;
    }

    // First-class cancelled state (spec §30): the terminal trip (with
    // cancelled_by + reason) is rendered before returning home — never a
    // blank/null exit. Exactly ONE dialog + ONE navigation per ride.
    if (trip == null && cancelledTrip != null && !_cancelledDialogShown) {
      _cancelledDialogShown = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _showRideCancelledDialog(
          context,
          cancelledTrip,
          navService,
        );
      });
    }

    // Accept rollback (server rejected acceptTrip): the optimistic trip
    // was reverted to null and the ride was NEVER server-confirmed. Pop
    // back to the dashboard instead of rendering a blank screen. Exactly
    // one navigation per ride — legit COMPLETED/CANCELLED exits take the
    // dialog paths below and are excluded by _tripEverConfirmed.
    if (trip == null &&
        cancelledTrip == null &&
        !_tripEverConfirmed &&
        !_phantomRollbackNotified) {
      _phantomRollbackNotified = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        navService.stopNavigation();
        Navigator.of(context).popUntil((route) => route.isFirst);
      });
    }

    // Legit COMPLETED exit: the server confirmed the ride and the trip
    // screen is being torn down. Stop navigation resources so a stale
    // `isNavigating` from this trip never leaks into the next one.
    if (trip == null &&
        cancelledTrip == null &&
        _tripEverConfirmed &&
        !_completionNavStopped) {
      _completionNavStopped = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        navService.stopNavigation();
      });
    }

    // Cancellation could not be confirmed by the server (spec §60): surface
    // the failure once while the trip remains active so the driver can retry.
    if (trip != null &&
        driverProvider.cancelConfirmFailed &&
        !_cancelFailureNotified) {
      _cancelFailureNotified = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        showSnackBar(driverProvider.lastCancelError ??
            'Cancellation could not be confirmed. Check your connection and try again.');
      });
    }

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

  void showSnackBar(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), behavior: SnackBarBehavior.floating),
    );
  }

  Widget _buildNavigation(
    models.Trip trip,
    DriverProvider driverProvider,
    NavigationService navService,
  ) {
    // Keep the NavigationService's leg in sync with the trip status.
    // Accept/Requested → pickup, InProgress → destination.
    final desiredLeg = trip.status == models.TripStatus.IN_PROGRESS
        ? NavigationLeg.destination
        : NavigationLeg.pickup;
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
          onCall: () => _dialParticipant(context, trip),
        ),
        // Cancel button — only visible before pickup (ACCEPTED status)
        if (trip.status == models.TripStatus.ACCEPTED)
          Positioned(
            top: MediaQuery.of(context).padding.top + 8,
            right: 16,
            child: SafeArea(
              child: GestureDetector(
                onTap: () => _showCancelDialog(context, driverProvider, trip),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  decoration: BoxDecoration(
                    color: const Color(0xFFC65A5A),
                    borderRadius: BorderRadius.circular(24),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withOpacity(0.2),
                        blurRadius: 8,
                        offset: const Offset(0, 3),
                      ),
                    ],
                  ),
                  child: const Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.close, color: Colors.white, size: 16),
                      SizedBox(width: 6),
                      Text(
                        'Cancel',
                        style: TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w600,
                          fontSize: 13,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
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

  void _showCancelDialog(BuildContext context, DriverProvider driverProvider, models.Trip trip) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: const Text('Cancel Ride?', style: TextStyle(fontWeight: FontWeight.w700)),
        content: const Text('Are you sure you want to cancel? This may affect your rating.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('No, Keep'),
          ),
          TextButton(
            onPressed: () async {
              Navigator.pop(ctx);
              // 042: cancelling an accepted ride requires a reason.
              final reason = await showModalBottomSheet<({String code, String label})>(
                context: context,
                backgroundColor: Colors.white,
                shape: const RoundedRectangleBorder(
                  borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
                ),
                isScrollControlled: true,
                builder: (sheetContext) => const CancellationReasonSheet(),
              );
              if (reason == null) return;
              // The backend is authoritative: submit the cancellation and
              // let the server-confirmed CANCELLED tripUpdate drive the
              // exit (first-class cancelled state). Do NOT pop the trip
              // screen optimistically — that's how blank/duplicate states
              // arise.
              driverProvider.cancelTrip(
                trip.id,
                reasonCode: reason.code,
                reasonText: reason.code == 'other' ? reason.label : null,
              );
            },
            child: const Text('Yes, Cancel', style: TextStyle(color: Color(0xFFC65A5A))),
          ),
        ],
      ),
    );
  }

  /// First-class ride-cancelled dialog (spec §30/§33/§58): renders WHO
  /// cancelled + WHY, stops navigation+voice+ride resources, then returns
  /// the driver home exactly once through a single navigation owner.
  Future<void> _showRideCancelledDialog(
    BuildContext context,
    models.Trip cancelled,
    NavigationService navService,
  ) async {
    // Ride resources stop BEFORE any UI transition (spec §31): TTS, route
    // updates, GPS listeners, speed monitor, reroute timers.
    navService.stopNavigation();
    NavigationVoiceService.instance.stop();

    final prefs = await SharedPreferences.getInstance();
    final ownId = prefs.getString('user_id');
    final isOwnCancel = ownId != null && cancelled.cancelledBy == ownId;

    final provider = Provider.of<DriverProvider>(context, listen: false);
    final confirmFailed = provider.cancelConfirmFailed;

    if (!mounted) return;
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) => RideCancelledDialog(
        cancelledTrip: cancelled,
        isOwnCancel: isOwnCancel,
        confirmFailed: confirmFailed,
      ),
    );

    if (!mounted) return;
    // Exactly one navigation out of the active-ride state.
    Provider.of<DriverProvider>(context, listen: false).ackCancelled();
    Navigator.of(context).popUntil((route) => route.isFirst);
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
          tipAmount: trip.tipAmount ?? 0.0,
          isDriver: true,
          driverEarningsCents: trip.driverEarningsCents,
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
                                  tipAmount: trip.tipAmount ?? 0.0,
                                  isDriver: true,
                                  driverEarningsCents: trip.driverEarningsCents,
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

  /// Native phone dialing (spec §17–§19): the OTHER party's authoritative
  /// phone number comes from the backend's users table (party-only), and
  /// the device's default dialer is opened via a tel: URI. No in-app/VoIP
  /// calling surface.
  Future<void> _dialParticipant(BuildContext context, models.Trip trip) async {
    try {
      final response = await ApiService.dio.get('/ride/${trip.id}/party-phone');
      final phone = response.data['phone_number']?.toString();
      if (phone == null || phone.trim().isEmpty) {
        showSnackBar('Unable to call this user.');
        return;
      }
      final uri = Uri(scheme: 'tel', path: phone.trim());
      final launched = await launchUrl(uri, mode: LaunchMode.externalApplication);
      if (!launched) {
        showSnackBar('Unable to open the phone app.');
      }
    } on DioException catch (e) {
      String? serverMsg;
      if (e.response?.data is Map) {
        serverMsg = (e.response!.data as Map)['error']?.toString();
      }
      showSnackBar(serverMsg ?? 'Unable to call this user.');
    } catch (e) {
      debugPrint('[TRIP] Dial failed: $e');
      showSnackBar('Unable to open the phone app.');
    }
  }
}

/// First-class "ride cancelled" dialog (spec §30/§33): shows who cancelled
/// and why, offers reporting regardless of who cancelled, then returns the
/// driver home.
class RideCancelledDialog extends StatelessWidget {
  final models.Trip cancelledTrip;
  final bool isOwnCancel;
  final bool confirmFailed;

  const RideCancelledDialog({
    super.key,
    required this.cancelledTrip,
    required this.isOwnCancel,
    required this.confirmFailed,
  });

  static const Map<String, String> _riderCancelLabels = {
    'driver_took_too_long': 'Driver took too long to arrive',
    'wrong_pickup': 'Wrong pickup location',
    'driver_unprofessional': 'Driver was unprofessional',
    'emergency': 'Emergency',
    'changed_plans': 'Plans changed',
    'other': 'Another reason',
  };

  String get _reasonLabel {
    final code = cancelledTrip.cancellationReasonCode;
    final text = cancelledTrip.cancellationReasonText;
    if (code == 'other' && text != null && text.isNotEmpty) return text;
    if (code != null) {
      final label = _riderCancelLabels[code];
      if (label != null) return label;
    }
    return text ?? 'No reason provided';
  }

  @override
  Widget build(BuildContext context) {
    final heading = confirmFailed
        ? 'Could not confirm cancellation'
        : isOwnCancel
            ? 'You cancelled this ride'
            : 'The rider cancelled this ride';
    final body = confirmFailed
        ? 'Your cancellation could not be confirmed. Check your connection — if the ride is still active, try cancelling again.'
        : isOwnCancel
            ? 'The ride has been cancelled. You can accept the next request.'
            : 'Reason: $_reasonLabel';

    return AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
      backgroundColor: Colors.white,
      title: Center(
        child: Column(
          children: [
            Icon(
              confirmFailed
                  ? Icons.wifi_off_rounded
                  : Icons.cancel_outlined,
              size: 40,
              color: confirmFailed ? const Color(0xFFC65A5A) : const Color(0xFF5B7760),
            ),
            const SizedBox(height: 12),
            Text(
              'Ride Cancelled',
              style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 22, color: Color(0xFF2F3A32)),
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
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: Color(0xFF2F3A32)),
          ),
          const SizedBox(height: 8),
          Text(
            body,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 13, color: Colors.grey, height: 1.4),
          ),
        ],
      ),
      actionsAlignment: MainAxisAlignment.center,
      actions: [
        if (!confirmFailed) ...[
          SizedBox(
            width: double.infinity,
            height: 46,
            child: OutlinedButton.icon(
              onPressed: () async {
                Navigator.pop(context);
                await showModalBottomSheet<bool>(
                  context: context,
                  backgroundColor: Colors.white,
                  shape: const RoundedRectangleBorder(
                    borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
                  ),
                  isScrollControlled: true,
                  builder: (_) => ReportSheet(rideId: cancelledTrip.id),
                );
              },
              icon: const Icon(Icons.report_gmailerrorred_outlined, size: 18, color: Color(0xFFC65A5A)),
              label: const Text('Report Rider', style: TextStyle(fontWeight: FontWeight.w700)),
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
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
            ),
            child: const Text('Done', style: TextStyle(fontWeight: FontWeight.w800)),
          ),
        ),
      ],
    );
  }
}