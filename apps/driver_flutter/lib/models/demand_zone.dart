// lib/models/demand_zone.dart
//
// Wire model for GET /api/heatmap. The backend aggregates anonymized rider
// activity (60-min window, H3 res-7 cells, time decay) into circles of
// "demand" — the driver app renders these as a translucent heat overlay.
// Every field here is server-computed; the client never invents a zone.

class DemandZone {
  final double lat;
  final double lng;
  final double radiusM;
  final double score;
  final int riders;

  const DemandZone({
    required this.lat,
    required this.lng,
    required this.radiusM,
    required this.score,
    required this.riders,
  });

  factory DemandZone.fromJson(Map<String, dynamic> json) {
    return DemandZone(
      lat: (json['lat'] as num).toDouble(),
      lng: (json['lng'] as num).toDouble(),
      radiusM: (json['radiusM'] as num?)?.toDouble() ?? 800,
      score: ((json['score'] as num?)?.toDouble() ?? 0).clamp(0.0, 1.0),
      riders: (json['riders'] as num?)?.toInt() ?? 0,
    );
  }
}

class DemandQuery {
  final List<DemandZone> zones;
  final DateTime generatedAt;
  final int windowMinutes;
  final DateTime expiresAt;

  const DemandQuery({
    required this.zones,
    required this.generatedAt,
    required this.windowMinutes,
    required this.expiresAt,
  });

  bool get isEmpty => zones.isEmpty;

  factory DemandQuery.fromJson(Map<String, dynamic> json) {
    final rawZones = (json['zones'] as List?) ?? const [];
    final zones = rawZones
        .whereType<Map<String, dynamic>>()
        .map(DemandZone.fromJson)
        .toList();
    return DemandQuery(
      zones: zones,
      generatedAt:
          DateTime.tryParse((json['generatedAt'] as String?) ?? '') ??
              DateTime.now(),
      windowMinutes: (json['windowMinutes'] as num?)?.toInt() ?? 60,
      expiresAt: DateTime.tryParse((json['expiresAt'] as String?) ?? '') ??
          DateTime.now().add(const Duration(minutes: 1)),
    );
  }
}