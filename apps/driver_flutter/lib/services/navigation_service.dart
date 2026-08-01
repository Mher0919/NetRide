import 'dart:async';
import 'package:flutter/material.dart';
import 'package:latlong2/latlong.dart';

import 'gps_tracker.dart';
import 'off_route_detector.dart';
import 'reroute_controller.dart';
import 'route_matcher.dart';
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
    final polyline = parseServerPolyline(data);

    final rawSteps = _normalizeSteps(data['steps'] as List? ?? []);
    final steps = RouteProgressCalculator.buildSteps(rawSteps);

    final engine = (data['engine'] as String?) ?? 'Backend-Gateway';
    final etaSec = (data['eta'] as num?)?.toDouble() ?? 0;
    final durationSec = (data['duration'] as num?)?.toDouble() ?? 0;
    final trafficEta = (data['trafficDurationSeconds'] as num?)?.toDouble();

    return NavigationRoute(
      polyline: polyline,
      rawSteps: rawSteps,
      steps: steps,
      totalMeters: (data['distance'] as num?)?.toDouble() ?? 0.0,
      etaSeconds: etaSec > 0 ? etaSec : durationSec,
      trafficEtaSeconds: trafficEta,
      speedLimitsByRoad: ((data['speedLimitsByRoad'] as Map?) ?? const {})
          .map((k, v) => MapEntry(k as String, (v as num).toInt())),
      engine: engine,
      cacheHit: data['cache_hit'] == true || data['cacheHit'] == true,
    );
  }

  /// Parse every polyline shape the backend may emit into a LatLng list:
  ///   - `points_list`: List<LatLng> (legacy) or List<[lng,lat]>
  ///   - `polyline`:    List<[lng,lat]>
  ///   - `geometry`:    GeoJSON LineString coordinates
  ///   - `encodedPolyline`: polyline6 string
  /// Order of precedence is fixed so a well-formed payload always wins
  /// regardless of which keys the wire happens to carry.
  static List<LatLng> parseServerPolyline(Map<String, dynamic> data) {
    final raw = data['points_list'] ?? data['polyline'];
    if (raw is List && raw.isNotEmpty) {
      final first = raw.first;
      if (first is LatLng) {
        return raw.whereType<LatLng>().toList();
      }
      final out = <LatLng>[];
      for (final c in raw) {
        if (c is List && c.length >= 2 && c[0] is num && c[1] is num) {
          out.add(LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble()));
        }
      }
      if (out.isNotEmpty) return out;
    }

    final geometry = data['geometry'];
    if (geometry is Map && geometry['type'] == 'LineString') {
      final coords = geometry['coordinates'] as List? ?? [];
      final out = <LatLng>[];
      for (final c in coords) {
        if (c is List && c.length >= 2 && c[0] is num && c[1] is num) {
          out.add(LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble()));
        }
      }
      if (out.isNotEmpty) return out;
    }

    final encoded = data['encodedPolyline'];
    if (encoded is String && encoded.isNotEmpty) {
      return decodePolyline6(encoded);
    }

    return const [];
  }

  /// Google polyline6 decoder (precision 1e5) -> List<LatLng>.
  static List<LatLng> decodePolyline6(String encoded) {
    final points = <LatLng>[];
    int index = 0;
    final len = encoded.length;
    int lat = 0;
    int lng = 0;

    while (index < len) {
      int b;
      int shift = 0;
      int result = 0;
      do {
        b = encoded.codeUnitAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      final dlat = (result & 1) != 0 ? ~(result >> 1) : result >> 1;
      lat += dlat;

      shift = 0;
      result = 0;
      do {
        b = encoded.codeUnitAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      final dlng = (result & 1) != 0 ? ~(result >> 1) : result >> 1;
      lng += dlng;

      points.add(LatLng(lat / 1e5, lng / 1e5));
    }

    return points;
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

class NavigationService extends ChangeNotifier {
  final RoutingService _routingService = RoutingService();
  final SpeedMonitor _speedMonitor = SpeedMonitor();
  late final RerouteController _rerouteController = RerouteController(
    onBackendReroute: _requestBackendReroute,
  );

  NavigationLeg _leg = NavigationLeg.pickup;
  NavigationRoute? _route;
  String? _tripId;
  RouteProgress? _progress;
  bool _isNavigating = false;

  /// Local map-matcher over the active route polyline. Rebuilt when a
  /// new route is applied; null between routes.
  RouteMatcher? _matcher;

  StreamSubscription<GpsFix>? _gpsSub;

  NavigationLeg get leg => _leg;
  NavigationRoute? get route => _route;
  RouteProgress? get progress => _progress;
  bool get isNavigating => _isNavigating;
  SpeedMonitor get speedMonitor => _speedMonitor;
  NavigationLeg? get currentLeg => _leg;
  RerouteStage get rerouteStage => _rerouteController.stage;
  OffRoutePhase get offRoutePhase =>
      _rerouteController.offRoutePhase;
  double get offRouteDeviationM =>
      _matcher?.lastSnap?.distanceMeters ?? 0;

  void _applyRoute(NavigationRoute route) {
    _route = route;
    _matcher = RouteMatcher.forPolyline(route.polyline);
    _progress = null;
    _lastNotifiedStepIndex = -1;
    _rerouteController.onRouteApplied();
  }

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

    _applyRoute(NavigationRoute.fromServer(data));

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
    _matcher = null;
    _progress = null;
    _tripId = null;
    _gpsSub?.cancel();
    _gpsSub = null;
    _speedMonitor.stop();
    _rerouteController.reset();
    NavigationVoiceService.instance.stop();
    notifyListeners();
  }

  void setLeg(NavigationLeg leg) {
    if (_leg == leg) return;
    _leg = leg;
    notifyListeners();
  }

  /// Manual reroute (UI "refresh route" button) and the controller's
  /// backend escalation both land here.
  Future<void> requestReroute(LatLng from) async {
    await _requestBackendReroute(from);
  }

  Future<void> _requestBackendReroute(LatLng from) async {
    if (_tripId == null || _route == null) return;
    _rerouteController.rerouting = true;
    try {
      final fresh = await _routingService.requestReroute(
        tripId: _tripId!,
        leg: _leg.name,
        from: from,
      );
      if (fresh != null) {
        _applyRoute(NavigationRoute.fromServer(fresh));
        await _speedMonitor.start(route: fresh);
        notifyListeners();
      }
    } finally {
      _rerouteController.rerouting = false;
    }
  }

  void _onGpsFix(GpsFix fix) {
    final route = _route;
    if (route == null || route.polyline.length < 2) return;

    final matcher = _matcher;
    if (matcher == null) return;

    // 1. Snap the fix onto the route (segment projection, spatial index).
    final headingValid = fix.speedMps > 0.5;
    final snap = matcher.match(
      fix.position,
      headingDeg: headingValid ? fix.headingDeg : null,
    );
    if (snap == null) return;

    // 2. Progress numbers come from the projection — no vertex scan.
    final progress = RouteProgressCalculator.compute(
      gps: fix.position,
      polyline: route.polyline,
      steps: route.steps,
      speedMps: fix.speedMps,
      totalMeters: route.totalMeters,
      snap: snap,
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

    // 3. Reroute state machine: hysteresis detector → local recovery →
    //    backend (cache ladder → Google), single-flight + cooldown.
    _rerouteController.onGpsFix(
      position: fix.position,
      snap: snap,
      speedMps: fix.speedMps,
      headingDeg: headingValid ? fix.headingDeg : null,
      headingValid: headingValid,
    );

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
