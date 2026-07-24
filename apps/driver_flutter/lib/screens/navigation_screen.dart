// apps/driver_flutter/lib/screens/navigation_screen.dart
//
// The driver-app navigation view. Replaces the OSM map inside
// trip_screen.dart with a heading-up GoogleMap, the five palette-
// matched components (TopManeuverCard, RoutingOptionsBar,
// SpeedHudCard, LaneGuidance, BottomSheetCard), and a rotated driver
// marker driven by the GPS heading.
//
// The screen is a passive consumer of NavigationService + GpsTracker;
// the trip_screen wires it in by passing the existing trip context
// (pickup/destination coords, trip id) and listening to the socket
// events (navigationLegAdvanced, navigationRouteUpdated).

import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart' as gmaps;
import 'package:provider/provider.dart';

import '../components/navigation/bottom_sheet_card.dart';
import '../components/navigation/lane_guidance.dart';
import '../components/navigation/routing_options_bar.dart';
import '../components/navigation/speed_hud.dart';
import '../components/navigation/top_maneuver_card.dart';
import '../services/gps_tracker.dart';
import '../services/navigation_service.dart';
import '../services/route_progress_calculator.dart';
import '../services/speed_monitor.dart';
import '../services/communication_service.dart';
import '../services/sound_service.dart';
import '../services/navigation_voice_service.dart';
import '../theme/app_theme.dart';

class NavigationScreen extends StatefulWidget {
  /// `true` if the driver is on the pickup leg (button should say
  /// "PICK UP RIDER"). `false` once they're heading to the destination
  /// ("COMPLETE TRIP" instead).
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
  gmaps.GoogleMapController? _mapController;

  @override
  Widget build(BuildContext context) {
    final nav = context.watch<NavigationService>();
    final gps = GpsTracker.instance.lastFix;
    final route = nav.route;
    final progress = nav.progress;

    // Polyline set for the GoogleMap. Single segment from cached leg.
    final polylines = <gmaps.Polyline>{};
    if (route != null && route.polyline.length >= 2) {
      polylines.add(
        gmaps.Polyline(
          polylineId: const gmaps.PolylineId('route'),
          points: route.polyline
              .map((p) => gmaps.LatLng(p.latitude, p.longitude))
              .toList(),
          width: 7,
          color: AppTheme.primaryBrandGreen,
          endCap: gmaps.Cap.roundCap,
          startCap: gmaps.Cap.roundCap,
          jointType: gmaps.JointType.round,
        ),
      );
    }

    // Driver marker. Heading is the compass bearing from the GPS fix;
    // GoogleMap rotates the marker counter-clockwise so we feed it
    // `360 - heading` to align north-up → map-heading-up.
    final markers = <gmaps.Marker>{};
    if (gps != null) {
      markers.add(
        gmaps.Marker(
          markerId: const gmaps.MarkerId('driver'),
          position:
              gmaps.LatLng(gps.position.latitude, gps.position.longitude),
          rotation: (360 - gps.headingDeg) % 360,
          flat: true,
          anchor: const Offset(0.5, 0.5),
          icon: gmaps.BitmapDescriptor.defaultMarkerWithHue(
            gmaps.BitmapDescriptor.hueAzure,
          ),
        ),
      );
    }

    // Top maneuver card data.
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

    // Lanes from the OSRM step.
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
          // 1. The map — fill the entire screen behind the overlays.
          Positioned.fill(
            child: gmaps.GoogleMap(
              initialCameraPosition: gmaps.CameraPosition(
                target: gps != null
                    ? gmaps.LatLng(
                        gps.position.latitude, gps.position.longitude)
                    : const gmaps.LatLng(34.0522, -118.2437),
                zoom: 17,
                tilt: 60,
              ),
              myLocationButtonEnabled: false,
              compassEnabled: true,
              zoomControlsEnabled: false,
              mapToolbarEnabled: false,
              polylines: polylines,
              markers: markers,
              onMapCreated: (c) {
                _mapController = c;
                // Animate to current GPS position once the map is ready.
                if (gps != null) {
                  c.animateCamera(gmaps.CameraUpdate.newLatLngZoom(
                    gmaps.LatLng(gps.position.latitude, gps.position.longitude),
                    17,
                  ));
                }
              },
            ),
          ),

          // 2. Top: Maneuver card + routing options bar.
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
                    const SizedBox(height: 10),
                    RoutingOptionsBar(
                      primaryRoad: currentStep?.name ?? '',
                      isFreeway: _isFreewayName(currentStep?.name ?? ''),
                      onRefresh: () {
                        final last = GpsTracker.instance.lastFix;
                        if (last != null) nav.requestReroute(last.position);
                      },
                    ),
                  ],
                ),
              ),
            ),
          ),

          // 3. Top-right: Speed HUD. Subscribes to SpeedMonitor's
          //    ValueNotifier so it rebuilds only when visible state
          //    changes (under/over limit), not every GPS tick.
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

          // 4. Voice Mute Floating Pill
          Positioned(
            right: 16,
            bottom: 250, // Pill sits above the BottomSheetCard
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

          // 5. Bottom: CTA sheet — driven by leg.
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
        etaSec > 0 ? 'ETA ${(etaSec / 60).ceil()} min' : 'ETA —';
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

  bool _isFreewayName(String name) {
    if (name.isEmpty) return false;
    return RegExp(
            r'\b(I-\d+|US-\d+|SR-\d+|CA-\d+|\bFwy\b|\bFreeway\b|\bInterstate\b|\bExpressway\b)',
            caseSensitive: false)
        .hasMatch(name);
  }

  String _capitalize(String? s) {
    if (s == null || s.isEmpty) return '';
    return s[0].toUpperCase() + s.substring(1);
  }
}

// Re-export for tests; TopManeuverCard owns the canonical mapping.
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