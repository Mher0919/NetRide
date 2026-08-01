// apps/driver_flutter/lib/services/local_recovery.dart
//
// Decides whether the driver can naturally rejoin the current route
// without any reroute request (missed turn, temporary detour, parking
// lot exit, gas station, neighborhood road). Only when recovery is
// impossible does the RerouteController escalate to a route request.
//
// Signals (fed 1 Hz):
//   - deviation trend: is the driver converging back toward the line?
//   - along-route progress: is the driver still moving toward the
//     destination even while off the polyline? (parallel road)
//   - heading: is the driver heading back at the route?

import 'route_matcher.dart';

enum RecoveryVerdict { recovering, worsening, stalled, neutral }

class RecoverySample {
  final double deviationM;
  final double alongM;
  final double headingErrorDeg;
  final DateTime at;

  const RecoverySample({
    required this.deviationM,
    required this.alongM,
    required this.headingErrorDeg,
    required this.at,
  });
}

class LocalRecoveryEngine {
  /// Deviation must shrink by this much to count as "recovering".
  final double recoveryGainM;

  /// Deviation must grow by this much (vs 10 s baseline) to count as
  /// "worsening".
  final double worseningGainM;

  /// Forward progress (meters) over the lookback window that counts as
  /// "still making progress on a parallel road".
  final double progressThresholdM;

  /// Heading error (deg) under which forward progress counts.
  final double alignedHeadingDeg;

  final List<RecoverySample> _samples = [];
  static const int _maxSamples = 15; // ~15 s at 1 Hz

  LocalRecoveryEngine({
    this.recoveryGainM = 12,
    this.worseningGainM = 25,
    this.progressThresholdM = 30,
    this.alignedHeadingDeg = 60,
  });

  RecoveryVerdict evaluate({
    required SnapResult snap,
    required double? headingDeg,
    required bool headingValid,
  }) {
    final now = DateTime.now();
    final headingError = headingValid && headingDeg != null
        ? RouteMatcher.headingDelta(snap.segmentHeadingDeg, headingDeg)
        : 180.0;

    _samples.add(RecoverySample(
      deviationM: snap.distanceMeters,
      alongM: snap.alongMeters,
      headingErrorDeg: headingError,
      at: now,
    ));
    if (_samples.length > _maxSamples) _samples.removeAt(0);
    if (_samples.length < 3) return RecoveryVerdict.neutral;

    final latest = _samples.last;

    // Baseline ~10 s ago (or as far back as we have).
    final baseline =
        _samples.firstWhere((s) => now.difference(s.at).inSeconds >= 9,
            orElse: () => _samples.first);

    final devDelta = baseline.deviationM - latest.deviationM;

    // 1. Converging: deviation dropped meaningfully — driver is heading
    //    back onto the line. Never reroute while this holds.
    if (devDelta >= recoveryGainM) {
      return RecoveryVerdict.recovering;
    }

    // 2. Diverging: deviation keeps growing.
    if (devDelta <= -worseningGainM) {
      return RecoveryVerdict.worsening;
    }

    // 3. Parallel road: heading roughly along the route and making
    //    forward progress — the route may be momentarily wrong but the
    //    driver is clearly still en route. Let it ride.
    final alongDelta = latest.alongM - baseline.alongM;
    if (alongDelta >= progressThresholdM && headingError <= alignedHeadingDeg) {
      return RecoveryVerdict.recovering;
    }

    // 4. Stalled: no convergence, no progress, big heading error.
    final timeDelta = now.difference(baseline.at).inSeconds;
    if (timeDelta >= 10 &&
        alongDelta.abs() < 15 &&
        headingError > alignedHeadingDeg) {
      return RecoveryVerdict.stalled;
    }

    return RecoveryVerdict.neutral;
  }

  void reset() => _samples.clear();
}
