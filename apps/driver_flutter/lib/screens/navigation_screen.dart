import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:provider/provider.dart';

import '../providers/driver_provider.dart';
import '../components/smooth_rider_marker.dart';
import '../components/navigation/bottom_sheet_card.dart';
import '../components/navigation/lane_guidance.dart';
import '../components/navigation/speed_hud.dart';
import '../components/navigation/top_maneuver_card.dart';
import '../services/gps_tracker.dart';
import '../services/navigation_service.dart';
import '../services/off_route_detector.dart';
import '../services/reroute_controller.dart';
import '../services/route_progress_calculator.dart';
import '../services/speed_monitor.dart';
import '../services/communication_service.dart';
import '../services/sound_service.dart';
import '../services/navigation_voice_service.dart';
import '../theme/app_theme.dart';

class NavigationScreen extends StatefulWidget {
  final bool canPickupRider;
  final bool canCompleteTrip;
  final VoidCallback? onPickupRider;
  final VoidCallback? onCompleteTrip;
  final String destinationAddress;
  final String pickupAddress;
  final VoidCallback? onChat;
  final VoidCallback? onCall;

  const NavigationScreen({
    super.key,
    required this.canPickupRider,
    required this.canCompleteTrip,
    this.onPickupRider,
    this.onCompleteTrip,
    required this.destinationAddress,
    required this.pickupAddress,
    this.onChat,
    this.onCall,
  });

  @override
  State<NavigationScreen> createState() => _NavigationScreenState();
}

class _NavigationScreenState extends State<NavigationScreen> {
  final MapController _mapController = MapController();

  /// While true the camera tracks the driver; any user pan/fling pauses
  /// follow for [_followPause] so the driver can inspect the map.
  bool _following = true;
  bool _mapReady = false;
  Timer? _followPauseTimer;
  static const Duration _followPause = Duration(seconds: 12);
  GpsFix? _lastFollowedFix;

  @override
  void initState() {
    super.initState();
    GpsTracker.instance.addListener(_onGpsTick);
  }

  @override
  void dispose() {
    _followPauseTimer?.cancel();
    GpsTracker.instance.removeListener(_onGpsTick);
    super.dispose();
  }

  void _onGpsTick() {
    if (!_following || !_mapReady) return;
    final fix = GpsTracker.instance.lastFix;
    if (fix == null || fix == _lastFollowedFix) return;
    _lastFollowedFix = fix;
    _mapController.move(fix.position, _mapController.camera.zoom);
  }

  /// Locate button: snap back to the driver's current position and orient
  /// the map to face the way the phone is pointing (like the Explore map).
  void _locateMe() {
    final fix = GpsTracker.instance.lastFix;
    if (fix == null || !_mapReady) return;
    _following = true;
    _followPauseTimer?.cancel();
    _lastFollowedFix = null;
    _mapController.move(fix.position, _mapController.camera.zoom);
    _mapController.rotate(fix.headingDeg);
  }

  void _onUserMapGesture() {
    _following = false;
    _followPauseTimer?.cancel();
    _followPauseTimer = Timer(_followPause, () {
      _following = true;
      _lastFollowedFix = null; // snap back on the next fix
    });
  }

  @override
  Widget build(BuildContext context) {
    final nav = context.watch<NavigationService>();
    final gps = GpsTracker.instance.lastFix;
    final route = nav.route;
    final progress = nav.progress;

    // Live rider position pushed over the socket (riderLocationUpdate).
    // The marker itself interpolates between updates.
    final riderLocation = context.watch<DriverProvider>().riderLocation;

    // Off-route / reroute banner.
    final rerouteStage = nav.rerouteStage;
    final offRoute = nav.offRoutePhase == OffRoutePhase.offRoute;
    final showRerouteBanner =
        offRoute ||
        rerouteStage == RerouteStage.localRecovery ||
        rerouteStage == RerouteStage.backendRequest;

    final polylines = <Polyline<Object>>[];
    if (route != null && route.polyline.length >= 2) {
      polylines.add(
        Polyline<Object>(
          points: route.polyline,
          color: AppTheme.primaryBrandGreen,
          strokeWidth: 7.0,
          borderColor: Colors.white,
          borderStrokeWidth: 2.0,
        ),
      );
    }

    final markers = <Marker>[];
    if (gps != null) {
      markers.add(
        Marker(
          point: gps.position,
          width: 40,
          height: 40,
          child: _buildDriverMarker(gps.headingDeg),
        ),
      );
    }

    if (route != null) {
      if (route.polyline.isNotEmpty) {
        markers.add(
          Marker(
            point: route.polyline.last,
            width: 30,
            height: 30,
            child: _buildDestinationMarker(),
          ),
        );
      }
    }

    final currentStep = progress?.currentStep;
    final nextStep = progress?.nextStep;
    final nextManeuver = currentStep ?? nextStep;
    final instruction = nextManeuver != null
        ? (nextManeuver.name.isNotEmpty
            ? '${_capitalize(nextManeuver.modifier)} onto ${nextManeuver.name}'
            : _capitalize(nextManeuver.type))
        : 'Continue';
    final distanceToManeuver =
        nav.formatDistance(progress?.distanceToNextManeuver ?? 0);
    final maneuverIcon = nextManeuver != null
        ? maneuverIconFromOSRM(nextManeuver.type, nextManeuver.modifier)
        : Icons.navigation_rounded;

    final lanes = <LaneGuidance>[];
    if (route != null &&
        progress != null &&
        progress.currentStepIndex < route.rawSteps.length) {
      final rawStep = route.rawSteps[progress.currentStepIndex];
      final stepLanes = (rawStep['lanes'] as List?) ?? const [];
      for (final lane in stepLanes) {
        final indications = ((lane as Map)['indications'] as List?)
                ?.cast<String>() ??
            const [];
        final valid = (lane['valid'] == true);
        if (indications.isEmpty) continue;
        lanes.add(LaneGuidance(
          indication: indications.first.toLowerCase(),
          valid: valid,
        ));
      }
    }

    return Scaffold(
      body: Stack(
        children: [
          Positioned.fill(
            child: FlutterMap(
              mapController: _mapController,
              options: MapOptions(
                initialCenter: gps?.position ?? const LatLng(34.0522, -118.2437),
                initialZoom: 17.0,
                minZoom: 12,
                maxZoom: 18,
                onMapReady: () {
                  _mapReady = true;
                  if (gps != null) {
                    _mapController.move(gps.position, 17.0);
                  }
                },
                onMapEvent: (event) {
                  if (event is MapEventMoveStart ||
                      event is MapEventFlingAnimationStart ||
                      event is MapEventDoubleTapZoomEnd) {
                    _onUserMapGesture();
                  }
                },
              ),
              children: [
                TileLayer(
                  urlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
                  maxNativeZoom: 16,
                  userAgentPackageName: 'com.NetRide.driver',
                ),
                if (polylines.isNotEmpty)
                  PolylineLayer(polylines: polylines),
                MarkerLayer(markers: markers),
                if (riderLocation != null)
                  SmoothRiderMarker(
                    position: LatLng(riderLocation.lat, riderLocation.lng),
                  ),
              ],
            ),
          ),

          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                child: Column(
                  children: [
                    TopManeuverCard(
                      icon: maneuverIcon,
                      distanceLabel: distanceToManeuver,
                      instruction: instruction,
                      lanes: lanes,
                    ),
                    if (showRerouteBanner) ...[
                      const SizedBox(height: 10),
                      _buildRerouteBanner(
                        rerouteStage == RerouteStage.backendRequest,
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),

          Positioned(
            top: 0,
            right: 16,
            child: SafeArea(
              child: ValueListenableBuilder<SpeedHud>(
                valueListenable: nav.speedMonitor.hud,
                builder: (context, speedHudValue, _) {
                  return Padding(
                    padding: const EdgeInsets.only(top: 220),
                    child: SpeedHudCard(value: speedHudValue),
                  );
                },
              ),
            ),
          ),

          Positioned(
            right: 16,
            // Raised above the trip screen's "⋯" action menu (bottom: 322)
            // so the two floating controls stack without overlapping.
            bottom: 378,
            child: FloatingActionButton(
              heroTag: 'nav_locate_fab',
              mini: true,
              backgroundColor: Colors.white,
              foregroundColor: const Color(0xFF2F3A32),
              elevation: 4,
              shape: const CircleBorder(),
              onPressed: _locateMe,
              child: const Icon(Icons.my_location_rounded, size: 22),
            ),
          ),

          Positioned(
            right: 16,
            bottom: 250,
            child: ValueListenableBuilder<bool>(
              valueListenable: NavigationVoiceService.instance.mutedListenable,
              builder: (context, muted, _) {
                return Container(
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(24),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withOpacity(0.15),
                        blurRadius: 8,
                        offset: const Offset(0, 3),
                      ),
                    ],
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      SoundIconButton(
                        onPressed: () {
                          NavigationVoiceService.instance.setMuted(!muted);
                        },
                        icon: Icon(
                          muted ? Icons.volume_off_rounded : Icons.volume_up_rounded,
                          color: const Color(0xFF2F3A32),
                        ),
                      ),
                      Container(
                        margin: const EdgeInsets.only(right: 12),
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: muted ? Colors.red : Colors.green,
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
          ),

          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: _buildBottomSheet(nav, progress),
          ),
        ],
      ),
    );
  }

  Widget _buildBottomSheet(NavigationService nav, RouteProgress? progress) {
    final isPickupLeg = nav.leg == NavigationLeg.pickup;
    final heading =
        isPickupLeg ? 'EN ROUTE TO PICKUP' : 'EN ROUTE TO DESTINATION';
    final address =
        isPickupLeg ? widget.pickupAddress : widget.destinationAddress;
    final etaSec = progress?.etaSeconds ?? 0;
    final remaining = progress?.totalRemainingMeters ?? 0;
    final actionLabel = isPickupLeg ? 'PICK UP RIDER' : 'COMPLETE TRIP';
    final actionEnabled =
        isPickupLeg ? widget.canPickupRider : widget.canCompleteTrip;
    final onAction =
        isPickupLeg ? widget.onPickupRider : widget.onCompleteTrip;

    final etaLabel =
        etaSec > 0 ? 'ETA ${(etaSec / 60).ceil()} min' : 'ETA \u2014';
    final remainingLabel = nav.formatDistance(remaining);

    final comm = context.watch<CommunicationService>();

    return SafeArea(
      top: false,
      child: BottomSheetCard(
        heading: heading,
        destinationAddress: address,
        etaLabel: etaLabel,
        remainingLabel: remainingLabel,
        actionLabel: actionLabel,
        actionEnabled: actionEnabled,
        onAction: onAction,
        showProgress: true,
        progressFraction: progress?.progressFraction ?? 0,
        onChat: widget.onChat,
        onCall: widget.onCall,
        callActive: comm.callPhase != CallPhase.idle,
      ),
    );
  }

  Widget _buildRerouteBanner(bool fetching) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: const Color(0xFFFFF3E0),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFFF0B429), width: 1),
      ),
      child: Row(
        children: [
          if (fetching) ...[
            const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            const SizedBox(width: 10),
          ] else ...[
            const Icon(Icons.swap_horiz_rounded,
                color: Color(0xFFB97A00), size: 18),
            const SizedBox(width: 10),
          ],
          Expanded(
            child: Text(
              fetching
                  ? 'Rerouting\u2026'
                  : 'Off route \u2014 finding the best way back',
              style: const TextStyle(
                color: Color(0xFF8A5A00),
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildDriverMarker(double headingDeg) {
    return Transform.rotate(
      angle: headingDeg * (3.14159 / 180),
      child: Container(
        width: 32,
        height: 32,
        decoration: BoxDecoration(
          color: AppTheme.primaryBrandGreen,
          shape: BoxShape.circle,
          border: Border.all(color: Colors.white, width: 3),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withOpacity(0.3),
              blurRadius: 6,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        child: const Icon(
          Icons.navigation,
          color: Colors.white,
          size: 18,
        ),
      ),
    );
  }

  Widget _buildDestinationMarker() {
    return const Icon(
      Icons.location_on,
      color: Color(0xFFC65A5A),
      size: 30,
    );
  }

  String _capitalize(String? s) {
    if (s == null || s.isEmpty) return '';
    return s[0].toUpperCase() + s.substring(1);
  }
}

IconData maneuverIconFromOSRM(String type, String modifier) {
  switch (type) {
    case 'arrive':
      return Icons.flag_rounded;
    case 'depart':
      return Icons.play_arrow_rounded;
    case 'merge':
      return Icons.merge_type_rounded;
    case 'fork':
    case 'end of road':
      return Icons.call_split_rounded;
    case 'roundabout':
    case 'rotary':
      return Icons.roundabout_right_rounded;
    case 'continue':
      return Icons.straight_rounded;
    case 'new name':
      return Icons.straight_rounded;
    case 'turn':
      switch (modifier) {
        case 'left':
          return Icons.turn_left_rounded;
        case 'right':
          return Icons.turn_right_rounded;
        case 'slight left':
          return Icons.turn_slight_left_rounded;
        case 'slight right':
          return Icons.turn_slight_right_rounded;
        case 'sharp left':
          return Icons.turn_sharp_left_rounded;
        case 'sharp right':
          return Icons.turn_sharp_right_rounded;
        case 'uturn':
          return Icons.u_turn_left_rounded;
        default:
          return Icons.straight_rounded;
      }
    default:
      return Icons.navigation_rounded;
  }
}
