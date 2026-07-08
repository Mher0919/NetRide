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
  static RouteProgress? compute({
    required LatLng gps,
    required List<LatLng> polyline, // must have >=2 points
    required List<ProgressStep> steps,
    required double speedMps,
    required double totalMeters,
  }) {
    if (polyline.length < 2 || totalMeters <= 0) return null;

    // 1. Snap GPS to the nearest polyline vertex (cheap O(N)). For
    //    production we'd run a true point-on-segment projection here,
    //    but the driver app's polyline is already dense (5-10m
    //    between vertices after enrichSteps), so vertex-snapping is
    //    accurate enough for HUD numbers and lane guidance.
    int snapIdx = 0;
    double minDist = double.infinity;
    for (int i = 0; i < polyline.length; i++) {
      final d = const Distance().as(LengthUnit.Meter, gps, polyline[i]);
      if (d < minDist) {
        minDist = d;
        snapIdx = i;
      }
    }
    final snapped = polyline[snapIdx];
    final snappedDistanceFromPolyline = minDist;

    // 2. Sum remaining distance from snap → end of leg. We treat each
    //    vertex as a 1D coordinate along the polyline; the snapIdx
    //    gives us a starting point.
    double remaining = 0;
    for (int i = snapIdx; i < polyline.length - 1; i++) {
      remaining += const Distance()
          .as(LengthUnit.Meter, polyline[i], polyline[i + 1]);
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
  static List<ProgressStep> buildSteps(
      List<Map<String, dynamic>> rawSteps) {
    double cursor = 0;
    final out = <ProgressStep>[];
    for (final s in rawSteps) {
      final length = (s['distance'] as num).toDouble();
      final loc = (s['maneuver']['location'] as List);
      out.add(
        ProgressStep(
          name: (s['name'] as String?) ?? '',
          lengthMeters: length,
          exitLocation: LatLng(loc[1] as double, loc[0] as double),
          modifier: (s['maneuver']['modifier'] as String?) ?? '',
          type: (s['maneuver']['type'] as String?) ?? '',
          cumulativeStartMeters: cursor,
        ),
      );
      cursor += length;
    }
    return out;
  }
}