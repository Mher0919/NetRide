import 'package:latlong2/latlong.dart';

class RouteStep {
  final double distanceMeters;
  final double durationSeconds;
  final String instruction;
  final String maneuver;
  final List<LatLng> polyline;

  const RouteStep({
    required this.distanceMeters,
    required this.durationSeconds,
    required this.instruction,
    required this.maneuver,
    required this.polyline,
  });

  factory RouteStep.fromJson(Map<String, dynamic> json) {
    final encodedPolyline = json['polyline'] as String? ?? '';
    return RouteStep(
      distanceMeters: (json['distanceMeters'] as num?)?.toDouble() ?? 0,
      durationSeconds: _parseDuration(json['duration'] as String? ?? '0s'),
      instruction: json['instruction'] as String? ?? '',
      maneuver: json['maneuver'] as String? ?? '',
      polyline: encodedPolyline.isNotEmpty
          ? _decodePolyline(encodedPolyline)
          : [],
    );
  }

  Map<String, dynamic> toJson() => {
    'distanceMeters': distanceMeters,
    'duration': '${durationSeconds}s',
    'instruction': instruction,
    'maneuver': maneuver,
  };

  static double _parseDuration(String duration) {
    final match = RegExp(r'(\d+(?:\.\d+)?)s').firstMatch(duration);
    if (match != null) return double.parse(match.group(1)!);
    return 0;
  }

  static List<LatLng> _decodePolyline(String encoded) {
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
}

class RouteResponse {
  final String originHex;
  final String destHex;
  final double distanceMeters;
  final double durationSeconds;
  final double? trafficDurationSeconds;
  final List<LatLng> polyline;
  final List<RouteStep> steps;
  final String engine;
  final bool cacheHit;

  const RouteResponse({
    required this.originHex,
    required this.destHex,
    required this.distanceMeters,
    required this.durationSeconds,
    this.trafficDurationSeconds,
    required this.polyline,
    required this.steps,
    required this.engine,
    required this.cacheHit,
  });

  factory RouteResponse.fromJson(Map<String, dynamic> json) {
    final stepsRaw = json['steps'] as List<dynamic>? ?? [];
    return RouteResponse(
      originHex: json['origin_hex'] as String? ?? '',
      destHex: json['dest_hex'] as String? ?? '',
      distanceMeters: (json['distanceMeters'] as num?)?.toDouble() ?? 0,
      durationSeconds: (json['durationSeconds'] as num?)?.toDouble() ?? 0,
      trafficDurationSeconds: (json['trafficDurationSeconds'] as num?)?.toDouble(),
      polyline: _decodePolylineFromGeometry(json['geometry']),
      steps: stepsRaw.map((s) => RouteStep.fromJson(s as Map<String, dynamic>)).toList(),
      engine: json['engine'] as String? ?? 'GoogleRoutes',
      cacheHit: json['cacheHit'] as bool? ?? false,
    );
  }

  Map<String, dynamic> toCacheJson() => {
    'originHex': originHex,
    'destHex': destHex,
    'distanceMeters': distanceMeters,
    'durationSeconds': durationSeconds,
    'trafficDurationSeconds': trafficDurationSeconds,
    'steps': steps.map((s) => s.toJson()).toList(),
    'engine': engine,
    'cachedAt': DateTime.now().toIso8601String(),
  };

  double get distanceMiles => distanceMeters / 1609.34;
  double get durationMinutes => (trafficDurationSeconds ?? durationSeconds) / 60;
  String get etaLabel {
    final min = durationMinutes.round();
    if (min < 60) return '$min min';
    final hours = min ~/ 60;
    final mins = min % 60;
    return '${hours}h ${mins}min';
  }

  static List<LatLng> _decodePolylineFromGeometry(dynamic geometry) {
    if (geometry == null) return [];
    if (geometry is Map && geometry['type'] == 'LineString') {
      final coords = geometry['coordinates'] as List? ?? [];
      return coords.map((c) {
        final pair = c as List;
        return LatLng((pair[1] as num).toDouble(), (pair[0] as num).toDouble());
      }).toList();
    }
    return [];
  }
}

class RouteSummary {
  final String originHex;
  final String destHex;
  final double distanceMeters;
  final double durationSeconds;
  final double? trafficDurationSeconds;
  final DateTime cachedAt;

  const RouteSummary({
    required this.originHex,
    required this.destHex,
    required this.distanceMeters,
    required this.durationSeconds,
    this.trafficDurationSeconds,
    required this.cachedAt,
  });

  double get durationMinutes => (trafficDurationSeconds ?? durationSeconds) / 60;

  bool needsRefresh({Duration maxAge = const Duration(minutes: 15)}) {
    return DateTime.now().difference(cachedAt) > maxAge;
  }
}
