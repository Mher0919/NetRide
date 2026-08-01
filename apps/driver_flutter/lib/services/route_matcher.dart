// apps/driver_flutter/lib/services/route_matcher.dart
//
// Local map-matching engine. Every GPS fix is snapped to the nearest
// ROUTE SEGMENT (point-on-segment projection, not vertex snapping) using
// a lightweight spatial index so the hot path is O(1)-ish instead of
// O(N).
//
// Responsibilities:
//   - Build a one-time `RouteIndex` (grid buckets + cumulative distance)
//     per navigation route — never rebuilt per fix.
//   - Snap: candidate segments from the 3x3 bucket neighborhood around
//     the GPS point, scored by perpendicular distance + heading
//     alignment + adjacency to the previously matched segment.
//   - Anti-oscillation: prefer the previous segment's neighborhood,
//     reject absurd snap distances (GPS jumps), and never allow the
//     matched position to move backwards along the route.
//   - Produce progress: along-route meters, remaining meters, remaining
//     ETA (pure local math — no Google).

import 'dart:math' as math;
import 'package:latlong2/latlong.dart';

/// Result of snapping one GPS fix onto the route polyline.
class SnapResult {
  /// Projected point on the route (or nearest vertex for degenerate cases).
  final LatLng point;

  /// Index of the matched segment: polyline[segmentIndex] -> [segmentIndex+1].
  final int segmentIndex;

  /// Distance from route start to the projection, along the polyline.
  final double alongMeters;

  /// Perpendicular distance from the raw GPS point to the route.
  final double distanceMeters;

  /// Bearing (0-360) of the matched segment — used for heading checks.
  final double segmentHeadingDeg;

  const SnapResult({
    required this.point,
    required this.segmentIndex,
    required this.alongMeters,
    required this.distanceMeters,
    required this.segmentHeadingDeg,
  });
}

/// Prebuilt spatial index over a route polyline.
class RouteIndex {
  final List<LatLng> polyline;

  /// cumulative[i] = distance along the route from polyline[0] to polyline[i].
  final List<double> cumulative;

  final double totalMeters;

  /// gridKey (latCell << 20 | lngCell) -> segment indices whose midpoint
  /// falls in that bucket. Bucket size ~100 m.
  final Map<int, List<int>> _buckets;
  static const double _cellMeters = 100.0;
  static const double _cellLatDeg = _cellMeters / 111320.0;

  RouteIndex._(this.polyline, this.cumulative, this.totalMeters, this._buckets);

  /// Build the index. O(N); called once per route (or reroute).
  factory RouteIndex.build(List<LatLng> polyline) {
    final n = polyline.length;
    final cumulative = List<double>.filled(n, 0.0);
    for (int i = 1; i < n; i++) {
      cumulative[i] =
          cumulative[i - 1] + RouteMatcher._haversineMeters(polyline[i - 1], polyline[i]);
    }
    final total = n > 1 ? cumulative[n - 1] : 0.0;

    final buckets = <int, List<int>>{};
    for (int i = 0; i < n - 1; i++) {
      final a = polyline[i];
      final b = polyline[i + 1];
      final key = _bucketKey((a.latitude + b.latitude) / 2, (a.longitude + b.longitude) / 2);
      buckets.putIfAbsent(key, () => []).add(i);
    }

    return RouteIndex._(polyline, cumulative, total, buckets);
  }

  static int _bucketKey(double lat, double lng) {
    final latCell = (lat / _cellLatDeg).round();
    final lngCell = (lng / _cellLatDeg).round();
    // Offset to keep keys positive-ish and unique for a wide range.
    return (latCell << 16) ^ (lngCell & 0xffff);
  }

  Iterable<int> _candidateSegments(LatLng gps) {
    final seen = <int>{};
    final baseKey = _bucketKey(gps.latitude, gps.longitude);
    for (int dx = -1; dx <= 1; dx++) {
      for (int dy = -1; dy <= 1; dy++) {
        final key = baseKey + (dx << 16) + dy;
        final segs = _buckets[key];
        if (segs != null) {
          for (final s in segs) {
            seen.add(s);
          }
        }
      }
    }
    return seen;
  }
}

class RouteMatcher {
  final RouteIndex index;
  final List<LatLng> polyline;

  int _lastSegment = 0;
  double _lastAlong = 0;
  SnapResult? _lastSnap;

  /// Max plausible snap distance; beyond this the fix is treated as a
  /// GPS jump and the previous snap is kept.
  static const double maxSnapDistanceM = 250;

  RouteMatcher(this.index) : polyline = index.polyline;

  static RouteMatcher? forPolyline(List<LatLng> polyline) {
    if (polyline.length < 2) return null;
    return RouteMatcher(RouteIndex.build(polyline));
  }

  /// Snap `gps` to the route. `headingDeg` (when valid) biases the
  /// candidate selection toward segments the driver is actually on.
  SnapResult? match(LatLng gps, {double? headingDeg}) {
    final segments = index._candidateSegments(gps);
    if (segments.isEmpty) {
      // Sparse polyline (very long segments): fall back to a window
      // around the last matched segment.
      return _matchInWindow(gps, headingDeg);
    }

    SnapResult? best;
    for (final seg in segments) {
      final result = _project(gps, seg);
      if (result == null) continue;
      if (best == null || _score(result, headingDeg) < _score(best, headingDeg)) {
        best = result;
      }
    }
    return _finalize(best, gps, headingDeg);
  }

  SnapResult? _matchInWindow(LatLng gps, double? headingDeg) {
    final start = math.max(0, _lastSegment - 2);
    final end = math.min(polyline.length - 2, _lastSegment + 2);
    SnapResult? best;
    for (int seg = start; seg <= end; seg++) {
      final result = _project(gps, seg);
      if (result == null) continue;
      if (best == null || _score(result, headingDeg) < _score(best, headingDeg)) {
        best = result;
      }
    }
    return _finalize(best, gps, headingDeg);
  }

  /// Lower score = better. Deviation dominates; heading alignment and
  /// adjacency to the previous segment are tie-breakers that prevent
  /// oscillation between parallel roads.
  double _score(SnapResult r, double? headingDeg) {
    var score = r.distanceMeters;
    if (headingDeg != null && !headingDeg.isNaN) {
      final delta = headingDelta(r.segmentHeadingDeg, headingDeg);
      score += math.min(delta, 60.0) * 0.5; // penalize heading mismatch mildly
    }
    score += (r.segmentIndex - _lastSegment).abs() * 4.0; // adjacency stickiness
    return score;
  }

  SnapResult? _finalize(SnapResult? best, LatLng gps, double? headingDeg) {
    if (best == null) return _lastSnap;
    if (best.distanceMeters > maxSnapDistanceM) {
      // GPS jump — hold the previous match instead of snapping wildly.
      return _lastSnap;
    }
    // Never let the matched position slip backwards.
    if (best.alongMeters < _lastAlong - 20) {
      best = _project(gps, _lastSegment) ?? best;
    }
    _lastSegment = best.segmentIndex;
    _lastAlong = best.alongMeters;
    _lastSnap = best;
    return best;
  }

  /// Project `gps` onto segment `i` (polyline[i] -> polyline[i+1]) using
  /// equirectangular meters — fast plane math, accurate under ~2 km.
  SnapResult? _project(LatLng gps, int i) {
    final a = polyline[i];
    final b = polyline[i + 1];
    final cosLat = math.cos(a.latitude * math.pi / 180.0);
    final metersPerLat = 111320.0;
    final metersPerLng = metersPerLat * cosLat;

    final ax = a.longitude * metersPerLng;
    final ay = a.latitude * metersPerLat;
    final bx = b.longitude * metersPerLng;
    final by = b.latitude * metersPerLat;
    final px = gps.longitude * metersPerLng;
    final py = gps.latitude * metersPerLat;

    final dx = bx - ax;
    final dy = by - ay;
    final segLenSq = dx * dx + dy * dy;
    if (segLenSq < 1e-9) return null;

    var t = ((px - ax) * dx + (py - ay) * dy) / segLenSq;
    t = t.clamp(0.0, 1.0);

    final sx = ax + t * dx;
    final sy = ay + t * dy;
    final point = LatLng(sy / metersPerLat, sx / metersPerLng);

    final dist = math.sqrt((px - sx) * (px - sx) + (py - sy) * (py - sy));

    // Along-route distance: cumulative to segment start + t * segment length.
    final segmentMeters = math.sqrt(segLenSq);
    final along = index.cumulative[i] + t * segmentMeters;

    return SnapResult(
      point: point,
      segmentIndex: i,
      alongMeters: along,
      distanceMeters: dist,
      segmentHeadingDeg: _bearingDeg(a, b),
    );
  }

  double get totalMeters => index.totalMeters;
  SnapResult? get lastSnap => _lastSnap;

  void reset() {
    _lastSegment = 0;
    _lastAlong = 0;
    _lastSnap = null;
  }

  // ---- Shared geometry helpers -------------------------------------------

  static double _haversineMeters(LatLng a, LatLng b) {
    const R = 6371000.0;
    final dLat = (b.latitude - a.latitude) * math.pi / 180.0;
    final dLng = (b.longitude - a.longitude) * math.pi / 180.0;
    final la = a.latitude * math.pi / 180.0;
    final lb = b.latitude * math.pi / 180.0;
    final h = math.sin(dLat / 2) * math.sin(dLat / 2) +
        math.cos(la) * math.cos(lb) * math.sin(dLng / 2) * math.sin(dLng / 2);
    return 2 * R * math.asin(math.min(1.0, math.sqrt(h)));
  }

  static double _bearingDeg(LatLng a, LatLng b) {
    final dLng = (b.longitude - a.longitude) * math.pi / 180.0;
    final la = a.latitude * math.pi / 180.0;
    final lb = b.latitude * math.pi / 180.0;
    final y = math.sin(dLng) * math.cos(lb);
    final x = math.cos(la) * math.sin(lb) -
        math.sin(la) * math.cos(lb) * math.cos(dLng);
    return (math.atan2(y, x) * 180.0 / math.pi + 360.0) % 360.0;
  }

  static double headingDelta(double aDeg, double bDeg) {
    final d = (aDeg - bDeg) % 360.0;
    return d > 180.0 ? 360.0 - d : d.abs();
  }
}

