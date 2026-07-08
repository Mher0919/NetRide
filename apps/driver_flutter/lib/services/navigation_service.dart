// apps/driver_flutter/lib/services/navigation_service.dart
//
// In-app navigation coordinator for the driver app. Holds the cached
// route for the active leg, integrates the GPS feed (GpsTracker),
// the speed HUD (SpeedMonitor), and the local-only progress
// calculator (RouteProgressCalculator). Owns the off-route detection
// + manual reroute handshake with the backend.
//
// Two-leg model:
//
//   - pickup       : driver → rider pickup point
//   - destination  : rider pickup → drop-off
//
// The transition from `pickup` to `destination` happens when the
// driver app calls `arriveAtPickup()`. The backend emits the
// `navigationLegAdvanced` socket event when the trip status flips
// ACCEPTED → IN_PROGRESS; this service listens for that and swaps
// the cached route + steps + speed-limit map.

import 'dart:async';
import 'package:flutter/material.dart';
import 'package:latlong2/latlong.dart';

import 'gps_tracker.dart';
import 'route_progress_calculator.dart';
import 'routing_service.dart';
import 'speed_monitor.dart';
import 'navigation_voice_service.dart';

enum NavigationLeg { pickup, destination }

class NavigationRoute {
  final List<LatLng> polyline;
  final List<Map<String, dynamic>> rawSteps;
  final List<ProgressStep> steps;
  final double totalMeters;
  final double etaSeconds;
  final Map<String, int> speedLimitsByRoad;
  final String engine;
  final bool cacheHit;

  NavigationRoute({
    required this.polyline,
    required this.rawSteps,
    required this.steps,
    required this.totalMeters,
    required this.etaSeconds,
    required this.speedLimitsByRoad,
    required this.engine,
    required this.cacheHit,
  });

  factory NavigationRoute.fromServer(Map<String, dynamic> data) {
    final polyline = (data['points_list'] as List?)?.cast<LatLng>() ?? <LatLng>[];
    final rawSteps = ((data['steps'] as List?) ?? const [])
        .cast<Map<String, dynamic>>();
    final steps = RouteProgressCalculator.buildSteps(rawSteps);
    return NavigationRoute(
      polyline: polyline,
      rawSteps: rawSteps,
      steps: steps,
      totalMeters: (data['distance'] as num?)?.toDouble() ?? 0.0,
      etaSeconds: (data['duration'] as num?)?.toDouble() ?? 0.0,
      speedLimitsByRoad: ((data['speedLimitsByRoad'] as Map?) ?? const {})
          .map((k, v) => MapEntry(k as String, (v as num).toInt())),
      engine: (data['engine'] as String?) ?? 'Backend-Gateway',
      cacheHit: data['cache_hit'] == true,
    );
  }
}

class RerouteManager {
  /// Sustained over-threshold samples needed before we reroute.
  /// 3 ticks @ 1 Hz = 3 seconds.
  static const int requiredTicks = 3;

  /// > 60 m off-route is "significant deviation" per the spec.
  static const double offRouteThresholdM = 60;

  int _consecutiveOff = 0;
  bool _isRerouting = false;

  /// Returns true when the manager decided a reroute should fire this
  /// tick. The caller is responsible for actually fetching the new
  /// route and resetting the manager.
  bool consider(double offRouteMeters) {
    if (_isRerouting) return false;
    if (offRouteMeters > offRouteThresholdM) {
      _consecutiveOff += 1;
      if (_consecutiveOff >= requiredTicks) {
        _consecutiveOff = 0;
        return true;
      }
    } else {
      _consecutiveOff = 0;
    }
    return false;
  }

  void markRerouting(bool busy) {
    _isRerouting = busy;
    if (!busy) _consecutiveOff = 0;
  }
}

class NavigationService extends ChangeNotifier {
  final RoutingService _routingService = RoutingService();
  final SpeedMonitor _speedMonitor = SpeedMonitor();

  NavigationLeg _leg = NavigationLeg.pickup;
  NavigationRoute? _route;
  String? _tripId;
  RouteProgress? _progress;
  bool _isNavigating = false;

  StreamSubscription<GpsFix>? _gpsSub;

  // Public surface
  NavigationLeg get leg => _leg;
  NavigationRoute? get route => _route;
  RouteProgress? get progress => _progress;
  bool get isNavigating => _isNavigating;
  SpeedMonitor get speedMonitor => _speedMonitor;
  NavigationLeg? get currentLeg => _leg;
  RerouteManager reroute = RerouteManager();

  /// Begin navigation for a leg. Called from the driver app's
  /// `acceptTrip` (pickup) and `pickUpRider` (destination) flows. If
  /// `cachedRoute` is supplied, we skip the OSRM call (the server
  /// already pushed the route via navigationStarted).
  Future<void> startNavigation({
    required String tripId,
    required NavigationLeg leg,
    required LatLng start,
    required LatLng end,
    Map<String, dynamic>? cachedRoute,
  }) async {
    _tripId = tripId;
    _leg = leg;

    Map<String, dynamic>? data = cachedRoute;
    if (data == null) {
      // Fallback: ask the backend for the cached leg first (cheap),
      // then fall back to a fresh OSRM call.
      data = await _routingService.getCachedLeg(tripId: tripId, leg: leg.name);
      if (data == null) {
        data = await _routingService.getRoute(start, end);
      }
    }

    _route = NavigationRoute.fromServer(data);

    // Wire up the speed monitor with the freshly loaded limits.
    await _speedMonitor.start(route: data);

    // Subscribe to GPS. The GpsTracker is the single source of truth
    // for position updates — no double-subscribing from trip_screen.
    await GpsTracker.instance.start();
    _gpsSub?.cancel();
    _gpsSub = GpsTracker.instance.fixes.listen(_onGpsFix);

    _isNavigating = true;
    _speakRoutePreview();
    notifyListeners();
  }

  /// Switch from the pickup leg to the destination leg. Called when
  /// the driver app receives the navigationLegAdvanced socket event.
  Future<void> advanceToDestination({
    required LatLng start,
    required LatLng end,
    Map<String, dynamic>? cachedRoute,
  }) async {
    if (_leg != NavigationLeg.pickup) return;
    _leg = NavigationLeg.destination;
    await startNavigation(
      tripId: _tripId ?? '',
      leg: _leg,
      start: start,
      end: end,
      cachedRoute: cachedRoute,
    );
  }

  void stopNavigation() {
    _isNavigating = false;
    _route = null;
    _progress = null;
    _tripId = null;
    _gpsSub?.cancel();
    _gpsSub = null;
    _speedMonitor.stop();
    NavigationVoiceService.instance.stop();
    notifyListeners();
  }

  /// External hook called by trip_screen when the driver's status
  /// moves to IN_PROGRESS — keeps the leg in sync with the trip
  /// lifecycle.
  void setLeg(NavigationLeg leg) {
    if (_leg == leg) return;
    _leg = leg;
    notifyListeners();
  }

  /// Manual reroute request. Asks the server to re-route from the
  /// supplied position; replaces the cached leg + emits the
  /// navigationRouteUpdated payload to the driver room.
  Future<void> requestReroute(LatLng from) async {
    if (_tripId == null || _route == null) return;
    reroute.markRerouting(true);
    try {
      final fresh = await _routingService.requestReroute(
        tripId: _tripId!,
        leg: _leg.name,
        from: from,
      );
      if (fresh != null) {
        _route = NavigationRoute.fromServer(fresh);
        await _speedMonitor.start(route: fresh);
        notifyListeners();
      }
    } finally {
      reroute.markRerouting(false);
    }
  }

  // ---- Internals ---------------------------------------------------------

  void _onGpsFix(GpsFix fix) {
    final route = _route;
    if (route == null || route.polyline.length < 2) return;

    final progress = RouteProgressCalculator.compute(
      gps: fix.position,
      polyline: route.polyline,
      steps: route.steps,
      speedMps: fix.speedMps,
      totalMeters: route.totalMeters,
    );
    _progress = progress;

    // Notify the speed monitor when we step onto a new OSRM step so
    // the displayed speed limit tracks the road we're actually on.
    if (progress != null &&
        progress.currentStep != null &&
        progress.currentStepIndex != _lastNotifiedStepIndex) {
      _speedMonitor.notifyStepChanged(
        progress.currentStepIndex,
        route.rawSteps,
      );
      _lastNotifiedStepIndex = progress.currentStepIndex;
      
      if (!NavigationVoiceService.instance.muted) {
        _speakNextManeuver(progress);
      }
    }

    // Reroute manager: if sustained off-route, ask the server for a
    // fresh leg. This is fire-and-forget; on success the new
    // route payload will arrive via the navigationRouteUpdated socket
    // event (which the driver provider already listens for).
    if (progress != null &&
        reroute.consider(progress.snappedDistanceFromPolyline)) {
      requestReroute(fix.position).catchError((_) {});
    }

    notifyListeners();
  }

  void _speakRoutePreview() {
    final route = _route;
    if (route == null || route.steps.isEmpty) return;

    final first = route.steps.first;
    String text = "";
    if (first.name.isNotEmpty) {
      text = "Head onto ${first.name}.";
    } else {
      text = "Head forward.";
    }

    if (route.steps.length > 1) {
      final next = route.steps[1];
      final distanceStr = formatDistance(next.cumulativeStartMeters);
      String nextText = "";
      if (next.name.isNotEmpty) {
        final modifierStr = next.modifier.isNotEmpty ? next.modifier : 'proceed';
        nextText = "In $distanceStr, turn $modifierStr onto ${next.name}.";
      } else if (next.type.isNotEmpty) {
        nextText = "In $distanceStr, ${next.type}.";
      }
      if (nextText.isNotEmpty) {
        text += " $nextText";
      }
    }
    NavigationVoiceService.instance.speak(text);
  }

  void _speakNextManeuver(RouteProgress progress) {
    final nextManeuver = progress.currentStep ?? progress.nextStep;
    if (nextManeuver == null) return;
    
    final distanceStr = formatDistance(progress.distanceToNextManeuver);
    String instruction = "";
    if (nextManeuver.name.isNotEmpty) {
      final modifierStr = nextManeuver.modifier.isNotEmpty ? nextManeuver.modifier : 'proceed';
      instruction = "$modifierStr onto ${nextManeuver.name}";
    } else if (nextManeuver.type.isNotEmpty) {
      instruction = nextManeuver.type;
    } else {
      instruction = "continue";
    }

    final text = "In $distanceStr, $instruction.";
    NavigationVoiceService.instance.speak(text);
  }

  int _lastNotifiedStepIndex = -1;

  String formatDistance(double meters) {
    if (meters >= 1000) {
      return "${(meters / 1000).toStringAsFixed(1)} km";
    }
    return "${meters.round()} m";
  }
}