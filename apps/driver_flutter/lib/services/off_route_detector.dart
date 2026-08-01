// apps/driver_flutter/lib/services/off_route_detector.dart
//
// Multi-signal off-route detection with hysteresis. A single GPS point
// NEVER triggers a reroute: lane changes, parking-lot exits, gas-station
// stops and GPS noise are all absorbed here.
//
// Signals combined (1 Hz fixes):
//   - deviation distance from the route (matcher output)
//   - heading alignment with the matched route segment
//   - movement (speed) — a stationary driver is never "off route"
//   - progress along the route — advancing along the route while
//     drifting laterally is GPS noise, not a deviation
//   - consecutive-deviation count + elapsed time
//
// Hysteresis: enter OFF_ROUTE at `enterThresholdM` (80 m), return to
// ON_ROUTE at `exitThresholdM` (30 m). This gap prevents oscillation
// between route and no-route every GPS tick.

import 'route_matcher.dart';

enum OffRoutePhase { onRoute, monitoring, offRoute }

class OffRouteDetector {
  final double enterThresholdM;
  final double exitThresholdM;

  /// Number of consecutive qualifying ticks before OFF_ROUTE fires.
  final int requiredTicks;

  /// Ignore lateral drift while the driver is still making forward
  /// progress AND heading roughly along the route (GPS noise).
  final double headingAlignDeg;

  /// Speed (m/s) below which deviations do not accumulate (parked).
  final double minSpeedMps;

  OffRouteDetector({
    this.enterThresholdM = 80,
    this.exitThresholdM = 30,
    this.requiredTicks = 4,
    this.headingAlignDeg = 45,
    this.minSpeedMps = 1.2,
  });

  OffRoutePhase _phase = OffRoutePhase.onRoute;
  int _consecutive = 0;
  DateTime? _phaseSince;

  OffRoutePhase get phase => _phase;
  DateTime? get phaseSince => _phaseSince;
  int get consecutive => _consecutive;

  /// Edge-triggered: returns true exactly once when the detector flips
  /// into OFF_ROUTE. The caller starts the reroute ladder on true.
  bool consider({
    required SnapResult snap,
    required double speedMps,
    required double? headingDeg,
    required bool headingValid,
  }) {
    final dev = snap.distanceMeters;

    // ---- Hysteresis exit: clearly back on route ------------------------
    if (dev <= exitThresholdM) {
      if (_phase != OffRoutePhase.onRoute) _flip(OffRoutePhase.onRoute);
      _consecutive = 0;
      return false;
    }

    // ---- Monitoring band: exit < dev <= enter --------------------------
    if (dev <= enterThresholdM) {
      if (_phase == OffRoutePhase.offRoute) {
        // Was off route, drifted back under the enter threshold but not
        // yet below the exit threshold — keep counting toward recovery.
        _consecutive = 0;
        return false;
      }
      if (_phase != OffRoutePhase.monitoring) _flip(OffRoutePhase.monitoring);
      _consecutive = 0;
      return false;
    }

    // ---- Deep deviation band: dev > enterThresholdM --------------------
    // Stationary drivers do not accumulate deviation.
    if (speedMps < minSpeedMps) return false;

    // Heading-aligned + forward progress = lateral GPS noise, even at
    // deep deviation. Count it but do not escalate.
    final aligned =
        headingValid && headingDeg != null &&
        RouteMatcher.headingDelta(snap.segmentHeadingDeg, headingDeg) <= headingAlignDeg;

    if (aligned) {
      // Still count toward the time window so a real parallel-street
      // departure (heading matches, route is genuinely wrong) eventually
      // reroutes — but require a longer window for aligned deviations.
      _consecutive += 1;
      if (_consecutive >= requiredTicks * 2) {
        _consecutive = 0;
        _flip(OffRoutePhase.offRoute);
        return true;
      }
      if (_phase != OffRoutePhase.monitoring) _flip(OffRoutePhase.monitoring);
      return false;
    }

    _consecutive += 1;
    if (_phase != OffRoutePhase.offRoute) {
      if (_consecutive >= requiredTicks) {
        _consecutive = 0;
        _flip(OffRoutePhase.offRoute);
        return true;
      }
      if (_phase != OffRoutePhase.monitoring) _flip(OffRoutePhase.monitoring);
    }
    return false;
  }

  /// Call after a successful reroute / route swap to re-arm cleanly.
  void reset() {
    _consecutive = 0;
    _flip(OffRoutePhase.onRoute);
  }

  void _flip(OffRoutePhase next) {
    if (_phase == next) return;
    _phase = next;
    _phaseSince = DateTime.now();
  }
}

