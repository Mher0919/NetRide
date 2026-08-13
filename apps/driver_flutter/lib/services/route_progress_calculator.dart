// apps/driver_flutter/lib/services/route_progress_calculator.dart
//
// Pure, no-side-effect navigation progress computation.
//
// Given a cached route polyline + the latest GPS fix, this returns:
//
//   - snappedPoint          : nearest point on the polyline
//   - distanceToNextManeuver: meters until the next OSRM step
//   - totalRemainingMeters  : meters until the leg endpoint
//   - etaSeconds            : rough remaining time
//   - progressFraction      : 0..1 along the leg
//   - currentStepIndex      : which step the driver is on
//   - snappedDistanceFromPolyline : for the reroute manager
//
// Why pure: the OSRM call is cached server-side; everything from here
// on out is local math. We never touch the network on this hot path.

import 'dart:math' as math;
import 'package:latlong2/latlong.dart';

import 'route_matcher.dart';

/// Lightweight Step view that the calculator consumes. Built from the
/// OSRM step payload (name, distance, location, maneuver).
class ProgressStep {
  final String name;
  final double lengthMeters;
  final LatLng exitLocation;
  final String modifier;
  final String type;

  /// Cumulative distance from the leg origin up to and including this
  /// step. Filled in by the route builder before we ever run compute().
  final double cumulativeStartMeters;

  const ProgressStep({
    required this.name,
    required this.lengthMeters,
    required this.exitLocation,
    required this.modifier,
    required this.type,
    required this.cumulativeStartMeters,
  });
}

class RouteProgress {
  final LatLng snappedPoint;
  final double totalRemainingMeters;
  final double distanceToNextManeuver;
  final double etaSeconds;
  final double progressFraction; // 0..1
  final int currentStepIndex;
  final double snappedDistanceFromPolyline;
  final ProgressStep? currentStep;
  final ProgressStep? nextStep;

  const RouteProgress({
    required this.snappedPoint,
    required this.totalRemainingMeters,
    required this.distanceToNextManeuver,
    required this.etaSeconds,
    required this.progressFraction,
    required this.currentStepIndex,
    required this.snappedDistanceFromPolyline,
    required this.currentStep,
    required this.nextStep,
  });
}

class RouteProgressCalculator {
  /// Allocated once per `startNavigation`. Kept on the caller (the
  /// NavigationService), passed in to compute(). We keep an `Immutable`
  /// view here because the math is pure.
  ///
  /// When `snap` (the RouteMatcher output) is supplied, the HUD numbers
  /// come from the true point-on-segment projection — O(1) instead of
  /// the O(N) vertex scan, and accurate even on sparse polylines. The
  /// vertex-scan path is kept as a fallback for callers without a
  /// matcher.
  static RouteProgress? compute({
    required LatLng gps,
    required List<LatLng> polyline, // must have >=2 points
    required List<ProgressStep> steps,
    required double speedMps,
    required double totalMeters,
    SnapResult? snap,
  }) {
    if (polyline.length < 2 || totalMeters <= 0) return null;

    // 1. Project GPS onto the route. With a matcher we get the exact
    //    segment projection; otherwise fall back to vertex snapping.
    double remaining = 0;
    final double snappedDistanceFromPolyline;
    final LatLng snapped;
    if (snap != null) {
      remaining = math.max(0.0, totalMeters - snap.alongMeters);
      snappedDistanceFromPolyline = snap.distanceMeters;
      snapped = snap.point;
    } else {
      int snapIdx = 0;
      double minDist = double.infinity;
      for (int i = 0; i < polyline.length; i++) {
        final d = const Distance().as(LengthUnit.Meter, gps, polyline[i]);
        if (d < minDist) {
          minDist = d;
          snapIdx = i;
        }
      }
      snapped = polyline[snapIdx];
      snappedDistanceFromPolyline = minDist;

      for (int i = snapIdx; i < polyline.length - 1; i++) {
        remaining += const Distance()
            .as(LengthUnit.Meter, polyline[i], polyline[i + 1]);
      }
    }

    // 3. Figure out which step we're on. Steps are sequential and
    //    cover the leg from index 0 to N-1; each step's exit
    //    location is roughly at cumulativeStart + length. We use the
    //    snapped fraction along the leg to pick the step.
    final traveled = totalMeters - remaining;
    int stepIdx = 0;
    for (int i = 0; i < steps.length; i++) {
      if (traveled >= steps[i].cumulativeStartMeters) {
        stepIdx = i;
      } else {
        break;
      }
    }
    final currentStep =
        stepIdx < steps.length ? steps[stepIdx] : (steps.isNotEmpty ? steps.last : null);
    final nextStep =
        stepIdx + 1 < steps.length ? steps[stepIdx + 1] : null;

    final distanceToNextManeuver = currentStep == null
        ? remaining
        : math.max(0.0, remaining - (totalMeters - currentStep.cumulativeStartMeters - currentStep.lengthMeters));

    // 4. ETA: don't divide by zero. Use 5 m/s as a floor (≈ 11 mph)
    //    so a stationary driver's countdown doesn't tick to infinity.
    final speed = math.max(speedMps, 5.0);
    final eta = remaining / speed;

    // 5. Progress fraction. Clamp to [0, 1] for the progress bar.
    final progress =
        totalMeters <= 0 ? 0.0 : (traveled / totalMeters).clamp(0.0, 1.0);

    return RouteProgress(
      snappedPoint: snapped,
      totalRemainingMeters: remaining,
      distanceToNextManeuver: distanceToNextManeuver,
      etaSeconds: eta,
      progressFraction: progress,
      currentStepIndex: stepIdx,
      snappedDistanceFromPolyline: snappedDistanceFromPolyline,
      currentStep: currentStep,
      nextStep: nextStep,
    );
  }

  /// Convert the OSRM step payload into our internal ProgressStep
  /// list with cumulativeStartMeters filled in. Called once when the
  /// route arrives; subsequent GPS ticks only call `compute()`.
  /// Never throws on malformed payloads — every field is guarded so a
  /// single bad step can't kill the route view.
  static List<ProgressStep> buildSteps(
      List<Map<String, dynamic>> rawSteps) {
    double cursor = 0;
    final out = <ProgressStep>[];
    for (final s in rawSteps) {
      final length = (s['distance'] as num?)?.toDouble() ?? 0.0;
      final maneuver = s['maneuver'];
      var exitLat = 0.0;
      var exitLng = 0.0;
      var modifier = '';
      var type = '';
      if (maneuver is Map) {
        final loc = maneuver['location'];
        if (loc is List && loc.length >= 2 && loc[0] is num && loc[1] is num) {
          exitLng = (loc[0] as num).toDouble();
          exitLat = (loc[1] as num).toDouble();
        }
        modifier = (maneuver['modifier'] as String?) ?? '';
        type = (maneuver['type'] as String?) ?? '';
      }
      out.add(
        ProgressStep(
          name: (s['name'] as String?) ?? '',
          lengthMeters: length,
          exitLocation: LatLng(exitLat, exitLng),
          modifier: modifier,
          type: type,
          cumulativeStartMeters: cursor,
        ),
      );
      cursor += length;
    }
    return out;
  }
}