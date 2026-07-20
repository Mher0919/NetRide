class SearchResult {
  final String displayName;
  final double lat;
  final double lon;
  final String state;
  final double? distanceMiles;
  final String type;

  SearchResult({
    required this.displayName,
    required this.lat,
    required this.lon,
    required this.state,
    this.distanceMiles,
    this.type = 'poi',
  });

  factory SearchResult.fromJson(Map<String, dynamic> json) {
    final distance = json['distance_miles'];
    return SearchResult(
      displayName: (json['display_name'] as String?)?.trim() ?? '',
      lat: _parseDouble(json['lat']),
      lon: _parseDouble(json['lon']),
      state: (json['state'] as String?)?.trim() ?? 'CA',
      distanceMiles: distance is num ? distance.toDouble() : null,
      type: (json['type'] as String?)?.trim() ?? 'poi',
    );
  }

  static double _parseDouble(dynamic value) {
    if (value == null) return 0.0;
    if (value is num) return value.toDouble();
    if (value is String) return double.tryParse(value) ?? 0.0;
    return 0.0;
  }

  bool get hasValidCoordinates => lat != 0.0 || lon != 0.0;

  @override
  String toString() => 'SearchResult($displayName, $lat, $lon)';
}
