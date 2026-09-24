import 'dart:math' as math;

/// Collapses high-frequency GPS fixes into a bounded, fluent stream of
/// location reports.
///
/// Guarantees:
///  - At most one report per [minInterval] (default 1 s — keeps the
///    server at ~60 reports/min, matching the backend socket budget).
///  - Suppresses stationary fixes via a distance/heading gate so an
///    idle device stops hammering the socket entirely.
///  - Resends the last known position after [maxStaleInterval] even if
///    nothing moved (acts as the presence heartbeat the backend relies
///    on to keep locations alive).
class LocationReporter {
  LocationReporter({
    required this.onReport,
    this.minInterval = const Duration(milliseconds: 1000),
    this.minDistanceM = 0,
    this.minHeadingDeltaDeg = 0,
    this.maxStaleInterval = const Duration(seconds: 4),
  });

  /// Invoked when a report should actually be sent.
  final void Function(double lat, double lng, {double heading}) onReport;

  /// Minimum time between two reports.
  final Duration minInterval;

  /// Suppress a report unless the position moved at least this far (m).
  final double minDistanceM;

  /// Suppress a report unless the heading changed by at least this much.
  final double minHeadingDeltaDeg;

  /// Force a report after this much silence (heartbeat).
  final Duration maxStaleInterval;

  DateTime? _lastSentAt;
  double? _lastLat;
  double? _lastLng;
  double? _lastHeading;

  void report(double lat, double lng, {double heading = 0}) {
    final now = DateTime.now();
    final lastAt = _lastSentAt;
    final stale = lastAt == null || now.difference(lastAt) >= maxStaleInterval;

    if (!stale && now.difference(lastAt) < minInterval) {
      return;
    }

    final lastLat = _lastLat;
    final lastLng = _lastLng;
    if (!stale && lastLat != null && lastLng != null) {
      final moved = _haversineMeters(lastLat, lastLng, lat, lng);
      final headingDelta =
          _headingDelta(_lastHeading ?? 0, heading).abs();
      if (moved < minDistanceM && headingDelta < minHeadingDeltaDeg) {
        return;
      }
    }

    _lastSentAt = now;
    _lastLat = lat;
    _lastLng = lng;
    _lastHeading = heading;
    onReport(lat, lng, heading: heading);
  }

  static double _haversineMeters(double lat1, double lng1, double lat2, double lng2) {
    const r = 6371000.0;
    final dLat = _rad(lat2 - lat1);
    final dLng = _rad(lng2 - lng1);
    final a = math.pow(math.sin(dLat / 2), 2) +
        math.cos(_rad(lat1)) * math.cos(_rad(lat2)) * math.pow(math.sin(dLng / 2), 2);
    return 2 * r * math.asin(math.sqrt(a));
  }

  /// Signed shortest rotation between two compass bearings (deg), in [-180, 180].
  static double _headingDelta(double from, double to) {
    var delta = (to - from) % 360;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    return delta;
  }

  static double _rad(double deg) => deg * math.pi / 180;
}