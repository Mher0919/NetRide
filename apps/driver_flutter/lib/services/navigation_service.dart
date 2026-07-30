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
  final double? trafficEtaSeconds;
  final Map<String, int> speedLimitsByRoad;
  final String engine;
  final bool cacheHit;

  NavigationRoute({
    required this.polyline,
    required this.rawSteps,
    required this.steps,
    required this.totalMeters,
    required this.etaSeconds,
    this.trafficEtaSeconds,
    required this.speedLimitsByRoad,
    required this.engine,
    required this.cacheHit,
  });

  factory NavigationRoute.fromServer(Map<String, dynamic> data) {
    final dynamic pointsRaw = data['points_list'] ?? data['polyline'] ?? [];
    final List<LatLng> polyline;
    if (pointsRaw is List) {
      polyline = pointsRaw.whereType<LatLng>().toList();
    } else {
      polyline = [];
    }

    final rawSteps = _normalizeSteps(data['steps'] as List? ?? []);
    final steps = RouteProgressCalculator.buildSteps(rawSteps);

    final engine = (data['engine'] as String?) ?? 'Backend-Gateway';
    final etaSec = (data['eta'] as num?)?.toDouble() ?? 0;
    final durationSec = (data['duration'] as num?)?.toDouble() ?? 0;

    return NavigationRoute(
      polyline: polyline,
      rawSteps: rawSteps,
      steps: steps,
      totalMeters: (data['distance'] as num?)?.toDouble() ?? 0.0,
      etaSeconds: etaSec > 0 ? etaSec : durationSec,
      trafficEtaSeconds: (data['trafficDurationSeconds'] as num?)?.toDouble(),
      speedLimitsByRoad: ((data['speedLimitsByRoad'] as Map?) ?? const {})
          .map((k, v) => MapEntry(k as String, (v as num).toInt())),
      engine: engine,
      cacheHit: data['cache_hit'] == true || data['cacheHit'] == true,
    );
  }

  static List<Map<String, dynamic>> _normalizeSteps(List<dynamic> rawSteps) {
    return rawSteps.map((s) {
      if (s is! Map) return <String, dynamic>{};
      final step = Map<String, dynamic>.from(s);

      if (step['maneuver'] != null) return step;

      final instruction = step['instruction'] as String? ?? '';
      final maneuver = step['maneuverStr'] as String? ?? step['maneuver'] as String? ?? '';

      if (maneuver.isNotEmpty || instruction.isNotEmpty) {
        final osrmMan = _googleManeuverToOsrm(maneuver);
        final roadName = _extractRoadName(instruction);
        step['name'] = roadName;
        step['maneuver'] = {
          'type': osrmMan['type'],
          'modifier': osrmMan['modifier'],
          'location': [0.0, 0.0],
        };
        step['distance'] = (step['distanceMeters'] as num?)?.toDouble() ?? 0;
        step['duration'] = (step['durationSeconds'] as num?)?.toDouble() ?? 0;
      }

      return step;
    }).toList();
  }

  static Map<String, String> _googleManeuverToOsrm(String maneuver) {
    switch (maneuver.toUpperCase()) {
      case 'TURN_LEFT':
      case 'SLIGHT_LEFT':
        return {'type': 'turn', 'modifier': 'left'};
      case 'TURN_RIGHT':
      case 'SLIGHT_RIGHT':
        return {'type': 'turn', 'modifier': 'right'};
      case 'TURN_SHARP_LEFT':
        return {'type': 'turn', 'modifier': 'sharp left'};
      case 'TURN_SHARP_RIGHT':
        return {'type': 'turn', 'modifier': 'sharp right'};
      case 'STRAIGHT':
      case 'KEEP_STRAIGHT':
        return {'type': 'continue', 'modifier': 'straight'};
      case 'FORK_LEFT':
        return {'type': 'fork', 'modifier': 'left'};
      case 'FORK_RIGHT':
        return {'type': 'fork', 'modifier': 'right'};
      case 'MERGE':
        return {'type': 'merge', 'modifier': 'straight'};
      case 'ROUNDABOUT_LEFT':
      case 'ROUNDABOUT_RIGHT':
        return {'type': 'roundabout', 'modifier': 'left'};
      case 'EXIT_LEFT':
        return {'type': 'off ramp', 'modifier': 'left'};
      case 'EXIT_RIGHT':
        return {'type': 'off ramp', 'modifier': 'right'};
      case 'ENTER_HIGHWAY_LEFT':
      case 'ENTER_HIGHWAY_RIGHT':
        return {'type': 'on ramp', 'modifier': 'right'};
      case 'KEEP_LEFT':
        return {'type': 'new name', 'modifier': 'left'};
      case 'KEEP_RIGHT':
        return {'type': 'new name', 'modifier': 'right'};
      case 'UTURN_LEFT':
      case 'UTURN_RIGHT':
        return {'type': 'uturn', 'modifier': 'left'};
      case 'ARRIVE':
      case 'DESTINATION':
        return {'type': 'arrive', 'modifier': 'straight'};
      case 'DEPART':
        return {'type': 'depart', 'modifier': 'straight'};
      default:
        return {'type': 'continue', 'modifier': 'straight'};
    }
  }

  static String _extractRoadName(String instruction) {
    final ontoMatch = RegExp(r'onto\s+(.+?)(?:\.|$)', caseSensitive: false).firstMatch(instruction);
    if (ontoMatch != null) return ontoMatch.group(1)!.trim();

    final atMatch = RegExp(r'at\s+(.+?)(?:\.|$)', caseSensitive: false).firstMatch(instruction);
    if (atMatch != null) return atMatch.group(1)!.trim();

    return '';
  }
}

class RerouteManager {
  static const int requiredTicks = 3;
  static const double offRouteThresholdM = 60;

  int _consecutiveOff = 0;
  bool _isRerouting = false;

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

  NavigationLeg get leg => _leg;
  NavigationRoute? get route => _route;
  RouteProgress? get progress => _progress;
  bool get isNavigating => _isNavigating;
  SpeedMonitor get speedMonitor => _speedMonitor;
  NavigationLeg? get currentLeg => _leg;
  RerouteManager reroute = RerouteManager();

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
      data = await _routingService.getCachedLeg(tripId: tripId, leg: leg.name);
      if (data == null) {
        data = await _routingService.getRoute(start, end);
      }
    }

    _route = NavigationRoute.fromServer(data);

    await _speedMonitor.start(route: data);

    await GpsTracker.instance.start();
    _gpsSub?.cancel();
    _gpsSub = GpsTracker.instance.fixes.listen(_onGpsFix);

    _isNavigating = true;
    _speakRoutePreview();
    notifyListeners();
  }

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

  void setLeg(NavigationLeg leg) {
    if (_leg == leg) return;
    _leg = leg;
    notifyListeners();
  }

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
    final mi = meters / 1609.34;
    if (mi >= 0.1) {
      return "${mi.toStringAsFixed(1)} mi";
    }
    return "${(meters * 3.28084).round()} ft";
  }
}
