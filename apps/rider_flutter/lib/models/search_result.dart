class SearchResult {
  final String displayName;
  final double lat;
  final double lon;
  final String state;
  final double? distanceMiles;
  final String type;
  final bool isSuggestion;

  // New rich fields
  final String? formattedAddress;
  final String? street;
  final String? city;
  final String? zip;
  final String? category;
  final String? subcategory;
  final double? etaMinutes;

  SearchResult({
    required this.displayName,
    required this.lat,
    required this.lon,
    required this.state,
    this.distanceMiles,
    this.type = 'poi',
    this.isSuggestion = false,
    this.formattedAddress,
    this.street,
    this.city,
    this.zip,
    this.category,
    this.subcategory,
    this.etaMinutes,
  });

  factory SearchResult.fromJson(Map<String, dynamic> json) {
    final distance = json['distance_miles'];
    final dist = distance is num ? distance.toDouble() : null;

    return SearchResult(
      displayName: (json['display_name'] as String?)?.trim() ??
          (json['name'] as String?)?.trim() ??
          '',
      lat: _parseDouble(json['lat']),
      lon: _parseDouble(json['lon']),
      state: (json['state'] as String?)?.trim() ?? 'CA',
      distanceMiles: dist,
      type: (json['type'] as String?)?.trim() ?? (json['category'] as String?) ?? 'poi',
      isSuggestion: json['is_suggestion'] == true,
      formattedAddress: (json['formatted_address'] as String?)?.trim(),
      street: (json['street'] as String?)?.trim(),
      city: (json['city'] as String?)?.trim(),
      zip: (json['zip'] as String?)?.trim(),
      category: (json['category'] as String?)?.trim(),
      subcategory: (json['subcategory'] as String?)?.trim(),
      etaMinutes: dist != null ? _estimateEta(dist) : null,
    );
  }

  SearchResult copyWith({
    String? displayName,
    double? lat,
    double? lon,
    String? state,
    double? distanceMiles,
    String? type,
    bool? isSuggestion,
    String? formattedAddress,
    String? street,
    String? city,
    String? zip,
    String? category,
    String? subcategory,
    double? etaMinutes,
  }) {
    return SearchResult(
      displayName: displayName ?? this.displayName,
      lat: lat ?? this.lat,
      lon: lon ?? this.lon,
      state: state ?? this.state,
      distanceMiles: distanceMiles ?? this.distanceMiles,
      type: type ?? this.type,
      isSuggestion: isSuggestion ?? this.isSuggestion,
      formattedAddress: formattedAddress ?? this.formattedAddress,
      street: street ?? this.street,
      city: city ?? this.city,
      zip: zip ?? this.zip,
      category: category ?? this.category,
      subcategory: subcategory ?? this.subcategory,
      etaMinutes: etaMinutes ?? this.etaMinutes,
    );
  }

  /// Primary display address — prefers formatted_address, falls back to street.
  String get displayAddress =>
      formattedAddress ??
      (street != null && city != null ? '$street, $city' : street ?? city ?? '');

  /// Human-readable ETA string like "2 min" or "12 min".
  String get etaText {
    if (etaMinutes == null) return '';
    final mins = etaMinutes!.ceil();
    if (mins < 1) return '<1 min';
    return '$mins min';
  }

  static double _parseDouble(dynamic value) {
    if (value == null) return 0.0;
    if (value is num) return value.toDouble();
    if (value is String) return double.tryParse(value) ?? 0.0;
    return 0.0;
  }

  /// Estimate driving ETA from distance in miles.
  /// Uses 30 mph average urban speed = 2 min per mile.
  static double? _estimateEta(double distanceMiles) {
    if (distanceMiles <= 0) return null;
    return distanceMiles * 2.0; // ~30 mph avg urban speed
  }

  bool get hasValidCoordinates => lat != 0.0 || lon != 0.0;

  @override
  String toString() => 'SearchResult($displayName, $lat, $lon, ${distanceMiles?.toStringAsFixed(1)}mi)';
}
