// apps/driver_flutter/lib/services/reroute_controller.dart
//
// The reroute decision state machine. One instance lives in the
// NavigationService; it is fed one GPS tick per second and decides when
// (and how) to recover from an off-route situation.
//
// State machine:
//
//   idle ──(detector fires, dev > enter threshold xN)──> localRecovery
//     ▲                                                     │
//     │                                 rejoin signal       │ no rejoin in ~10s
//     │                                                     ▼
//     │                                    backendRequest ◄──┘ (single-flight)
//     │                                                     │
//     │                                             new route applied
//     └─────────────────────────────────────────────────────┘
//
// Escalation is deliberately lazy: the backend `/navigation/reroute`
// endpoint runs its own cache ladder (stored ride leg → OD cache →
// Google), so one request covers both CACHE_LOOKUP and GOOGLE_REROUTE
// without the app ever guessing which one to hit.
//
// Safety rails:
//   - Single-flight: never two reroute requests in flight.
//   - Cooldown: after a backend reroute, a minimum quiet window passes
//     before the next request can fire (turn-arounds look like
//     off-route to the detector for a few seconds).
//   - Generation counter: applying a fresh route (or stopping
//     navigation) invalidates any pending recovery timers/callbacks.
//   - Local recovery runs BEFORE any network call; a driver who is
//     converging back onto the polyline never triggers a request.

import 'dart:async';
import 'package:latlong2/latlong.dart';

import 'local_recovery.dart';
import 'off_route_detector.dart';
import 'route_matcher.dart';

enum RerouteStage {
  /// On route (or deviation below the monitoring band).
  idle,

  /// Detector is accumulating (deviation between exit and enter
  /// thresholds, or aligned-drift band). No action.
  monitoring,

  /// Detector fired; the driver gets a few seconds to rejoin the route
  /// on their own before any network request is made.
  localRecovery,

  /// A backend reroute request is in flight (or the UI is requesting
  /// one). Single-flight.
  backendRequest,

  /// A reroute completed recently; automatic requests are suppressed
  /// until the cooldown lapses.
  cooldown,
}

class RerouteController {
  final OffRouteDetector _detector;
  final LocalRecoveryEngine _recovery;

  /// Invoked when the state machine decides a backend reroute is
  /// needed. The closure owns the HTTP call + route application.
  final Future<void> Function(LatLng from) onBackendReroute;

  /// Minimum gap between two backend reroute requests.
  final Duration cooldown;

  /// How long the driver is allowed to self-recover before escalating.
  final Duration maxLocalRecovery;

  RerouteController({
    required this.onBackendReroute,
    OffRouteDetector? detector,
    LocalRecoveryEngine? recoveryEngine,
    this.cooldown = const Duration(seconds: 20),
    this.maxLocalRecovery = const Duration(seconds: 10),
  })  : _detector = detector ?? OffRouteDetector(),
        _recovery = recoveryEngine ?? LocalRecoveryEngine();

  RerouteStage _stage = RerouteStage.idle;
  DateTime? _recoveryStartedAt;
  DateTime? _lastBackendAt;
  bool _requestInFlight = false;
  int _generation = 0;

  /// Set true by the owner while a reroute is actively applied; the
  /// controller then ignores every GPS tick (no cascade of triggers).
  bool rerouting = false;

  RerouteStage get stage => _stage;
  DateTime? get recoveryStartedAt => _recoveryStartedAt;
  bool get requestInFlight => _requestInFlight;

  /// Detector phase — surfaced for UI banners (e.g. "recalculating…").
  OffRoutePhase get offRoutePhase => _detector.phase;

  /// Feed one GPS tick. Pure state transitions; never blocks.
  void onGpsFix({
    required LatLng position,
    required SnapResult? snap,
    required double speedMps,
    required double? headingDeg,
    required bool headingValid,
  }) {
    if (rerouting || snap == null) return;

    // Hysteresis detector first: does the deviation qualify at all?
    final fired = _detector.consider(
      snap: snap,
      speedMps: speedMps,
      headingDeg: headingDeg,
      headingValid: headingValid,
    );

    // While in local recovery, the recovery engine has veto power over
    // the escalation ladder.
    if (_stage == RerouteStage.localRecovery) {
      _tickLocalRecovery(snap, headingDeg, headingValid, position);
      return;
    }

    if (!fired) return;

    // Detector fired and we are not already in local recovery.
    final now = DateTime.now();

    // Cooldown gate: too soon after the previous reroute. The detector
    // re-arms by itself, so the next qualifying tick after the cooldown
    // lapses will restart the ladder.
    if (_lastBackendAt != null &&
        now.difference(_lastBackendAt!) < cooldown) {
      _stage = RerouteStage.cooldown;
      return;
    }

    _recovery.reset();
    _recoveryStartedAt = now;
    _stage = RerouteStage.localRecovery;
  }

  void _tickLocalRecovery(
    SnapResult snap,
    double? headingDeg,
    bool headingValid,
    LatLng position,
  ) {
    final started = _recoveryStartedAt;
    if (started == null) {
      _finishRecovery();
      return;
    }

    // Rejoin signals: clearly back on the line, or converging.
    if (snap.distanceMeters <= _detector.exitThresholdM) {
      _finishRecovery();
      return;
    }
    final verdict = _recovery.evaluate(
      snap: snap,
      headingDeg: headingDeg,
      headingValid: headingValid,
    );
    if (verdict == RecoveryVerdict.recovering) {
      _finishRecovery();
      return;
    }

    // Escalate: worsening, stalled, or the window expired.
    if (verdict == RecoveryVerdict.worsening ||
        verdict == RecoveryVerdict.stalled ||
        DateTime.now().difference(started) >= maxLocalRecovery) {
      _finishRecovery();
      _requestBackendReroute(position);
    }
  }

  void _finishRecovery() {
    _recovery.reset();
    _recoveryStartedAt = null;
    _stage = RerouteStage.idle;
  }

  /// Single-flight backend request. Ignored when a request is already
  /// in flight (a newer GPS tick will not double-fire).
  void _requestBackendReroute(LatLng position) {
    if (_requestInFlight) return;
    final now = DateTime.now();
    if (_lastBackendAt != null &&
        now.difference(_lastBackendAt!) < cooldown) {
      _stage = RerouteStage.cooldown;
      return;
    }

    final gen = ++_generation;
    _requestInFlight = true;
    _stage = RerouteStage.backendRequest;
    onBackendReroute(position).whenComplete(() {
      _requestInFlight = false;
      if (gen != _generation) return; // superseded by reset()
      _lastBackendAt = DateTime.now();
      _finishRecovery();
    });
  }

  /// Call after a fresh route is applied (successful reroute, new leg,
  /// navigation started). Re-arms detector + recovery + cooldown book-
  /// keeping and invalidates any pending work.
  void onRouteApplied() {
    _generation++;
    _requestInFlight = false;
    _finishRecovery();
  }

  /// Full reset for stopNavigation.
  void reset() {
    onRouteApplied();
    _lastBackendAt = null;
    _stage = RerouteStage.idle;
  }
}
