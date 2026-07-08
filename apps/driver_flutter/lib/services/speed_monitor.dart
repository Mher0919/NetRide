// apps/driver_flutter/lib/services/speed_monitor.dart
//
// Computes a smoothed current speed + speed-limit HUD value from the
// GPS stream and the cached route's `speedLimitsByRoad` map.
//
// The HUD is a ValueListenable so the on-screen speed card rebuilds
// only when the visible state changes (under/over limit), not on
// every 1 Hz GPS tick.
//
// Warning thresholds (matching the backend SpeedingDetector + the
// driver's HUD):
//
//   - Regular road (isFreeway=false): mph > limit → warn
//   - Freeway     (isFreeway=true):  mph > limit + 10 → warn
//
// A 0.5-second low-pass filter smooths GPS jitter so the number on
// the HUD doesn't twitch when the device samples noise.

import 'dart:async';
import 'package:flutter/foundation.dart';

import 'gps_tracker.dart';

class SpeedHud {
  final int currentMph;
  final int speedLimitMph;
  final bool isSpeeding;
  final bool isFreeway;
  final String roadName;

  const SpeedHud({
    required this.currentMph,
    required this.speedLimitMph,
    required this.isSpeeding,
    required this.isFreeway,
    required this.roadName,
  });

  static const empty = SpeedHud(
    currentMph: 0,
    speedLimitMph: 0,
    isSpeeding: false,
    isFreeway: false,
    roadName: '',
  );

  @override
  String toString() =>
      'SpeedHud($currentMph mph / limit $speedLimitMph${isSpeeding ? " ⚠" : ""})';
}

/// Holds the per-leg speed-limit map populated when the route is
/// loaded. The route gives us `speedLimitsByRoad: { roadName → mph }`
/// keyed on `step.name` / `step.ref`.
class SpeedLimitMap {
  final Map<String, int> _byRoad;
  String _currentRoad;
  int _currentLimitMph;
  bool _currentIsFreeway;

  SpeedLimitMap._(this._byRoad, this._currentRoad, this._currentLimitMph,
      this._currentIsFreeway);

  factory SpeedLimitMap.fromRoute(Map<String, dynamic> route) {
    final raw = (route['speedLimitsByRoad'] as Map?) ?? const {};
    final byRoad = <String, int>{};
    raw.forEach((k, v) {
      final m = (v as num).toInt();
      if (m > 0) byRoad[k as String] = m;
    });

    // Pick the first key with a limit; that's the road the driver
    // is on for the majority of the leg (the detector makes the
    // same simplification on the backend).
    String name = '';
    int limit = 30;
    bool isFw = false;
    if (byRoad.isNotEmpty) {
      final first = byRoad.entries.first;
      name = first.key;
      limit = first.value;
      isFw = _isFreewayName(name);
    }
    return SpeedLimitMap._(byRoad, name, limit, isFw);
  }

  /// Update when the driver crosses onto a new step. The driver app
  /// calls this from `RouteProgressCalculator` whenever currentStepIndex
  /// advances.
  void updateToStep(int newStepIndex, List<Map<String, dynamic>> steps) {
    if (newStepIndex < 0 || newStepIndex >= steps.length) return;
    final s = steps[newStepIndex];
    final roadName = (s['name'] as String?) ?? '';
    final ref = (s['ref'] as String?) ?? '';
    final key = [roadName, ref].firstWhere(
      (k) => _byRoad.containsKey(k),
      orElse: () => '',
    );
    if (key.isEmpty) return;
    _currentRoad = key;
    _currentLimitMph = _byRoad[key] ?? _currentLimitMph;
    _currentIsFreeway = _isFreewayName(key);
  }

  int get limitMph => _currentLimitMph;
  bool get isFreeway => _currentIsFreeway;
  String get roadName => _currentRoad;

  static bool _isFreewayName(String s) {
    if (s.isEmpty) return false;
    final regex = RegExp(
      r'\b(I-\d+|US-\d+|SR-\d+|CA-\d+|\bFwy\b|\bFreeway\b|\bInterstate\b|\bExpressway\b)',
      caseSensitive: false,
    );
    return regex.hasMatch(s);
  }
}

class SpeedMonitor extends ChangeNotifier {
  final ValueNotifier<SpeedHud> hud = ValueNotifier(SpeedHud.empty);

  StreamSubscription<GpsFix>? _sub;
  SpeedLimitMap? _limits;

  // Exponential moving average for speed smoothing.
  double _smoothedMps = 0;
  static const double _alpha = 0.4; // higher = snappier
  static const double _mpsToMph = 2.23694;

  /// Start listening. Idempotent. Call from `startNavigation` after
  /// the cached route is in hand.
  Future<void> start({required Map<String, dynamic> route}) async {
    _limits = SpeedLimitMap.fromRoute(route);
    _sub?.cancel();
    _sub = GpsTracker.instance.fixes.listen(_onFix);
  }

  void notifyStepChanged(int stepIndex, List<Map<String, dynamic>> steps) {
    _limits?.updateToStep(stepIndex, steps);
    _recompute(); // force a HUD update with new limit
  }

  Future<void> stop() async {
    await _sub?.cancel();
    _sub = null;
    _limits = null;
    hud.value = SpeedHud.empty;
    notifyListeners();
  }

  @override
  void dispose() {
    stop();
    hud.dispose();
    super.dispose();
  }

  // ---- Internals ---------------------------------------------------------

  void _onFix(GpsFix fix) {
    if (fix.speedMps <= 0) {
      // Stationary — clamp speed to 0 so the HUD shows the driver
      // stopped, but still re-evaluate the limit/road state.
      _smoothedMps = 0;
      _recompute();
      return;
    }

    // EMA smoothing. Reject spikes > 60 m/s (~134 mph) as GPS glitches
    // so a single bad sample doesn't flash a 200 mph warning.
    if (fix.speedMps > 60) return;
    _smoothedMps =
        _alpha * fix.speedMps + (1 - _alpha) * _smoothedMps;
    _recompute();
  }

  void _recompute() {
    final mph = (_smoothedMps * _mpsToMph).round();
    final limit = _limits?.limitMph ?? 0;
    final isFw = _limits?.isFreeway ?? false;
    final threshold = (isFw ? limit + 10 : limit).toInt();
    final speeding = limit > 0 && mph > threshold;
    final road = _limits?.roadName ?? '';
    final next = SpeedHud(
      currentMph: mph,
      speedLimitMph: limit,
      isSpeeding: speeding,
      isFreeway: isFw,
      roadName: road,
    );
    // Only notify ValueListenable subscribers when the *visible*
    // state actually changed. Avoids hammering the HUD widget.
    if (_hudChanged(next, hud.value)) {
      hud.value = next;
      notifyListeners();
    }
  }

  bool _hudChanged(SpeedHud a, SpeedHud b) {
    return a.currentMph != b.currentMph ||
        a.isSpeeding != b.isSpeeding ||
        a.speedLimitMph != b.speedLimitMph ||
        a.roadName != b.roadName;
  }
}