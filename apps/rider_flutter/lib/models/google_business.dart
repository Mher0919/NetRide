// lib/models/google_business.dart
//
// Google business information as shaped by the Netride backend's Places
// proxy. Google remains the source of truth for business identity, rating,
// photos, hours and reviews — these models only render what the backend
// returns and degrade gracefully when a field is missing. Nothing here is
// persisted client-side beyond the provider's in-memory cache.

class GoogleBusinessPhoto {
  final String name;
  final int? width;
  final int? height;
  final String url;
  final String thumbUrl;
  final String? attributionName;
  final String? attributionUri;

  const GoogleBusinessPhoto({
    required this.name,
    this.width,
    this.height,
    required this.url,
    required this.thumbUrl,
    this.attributionName,
    this.attributionUri,
  });

  factory GoogleBusinessPhoto.fromJson(Map<String, dynamic> json) {
    final attribution = json['attribution'] as Map<String, dynamic>?;
    return GoogleBusinessPhoto(
      name: json['name'] as String? ?? '',
      width: json['width'] as int?,
      height: json['height'] as int?,
      url: json['url'] as String? ?? '',
      thumbUrl: json['thumbUrl'] as String? ?? '',
      attributionName: attribution?['displayName'] as String?,
      attributionUri: attribution?['uri'] as String?,
    );
  }
}

class GoogleBusinessReview {
  final String authorName;
  final String? authorPhotoUrl;
  final String? authorUri;
  final double rating;
  final String relativeTime;
  final String text;

  const GoogleBusinessReview({
    required this.authorName,
    this.authorPhotoUrl,
    this.authorUri,
    required this.rating,
    this.relativeTime = '',
    required this.text,
  });

  factory GoogleBusinessReview.fromJson(Map<String, dynamic> json) =>
      GoogleBusinessReview(
        authorName: json['authorName'] as String? ?? 'Google user',
        authorPhotoUrl: json['authorPhotoUrl'] as String?,
        authorUri: json['authorUri'] as String?,
        rating: (json['rating'] as num?)?.toDouble() ?? 0,
        relativeTime: json['relativeTime'] as String? ?? '',
        text: json['text'] as String? ?? '',
      );
}

class GoogleBusiness {
  final String placeId;
  final String name;
  final String? category;
  final String? address;
  final String? shortAddress;
  final double? latitude;
  final double? longitude;
  final double? rating;
  final int? reviewCount;
  final String? priceLevel;
  final String? businessStatus;
  final String? googleMapsUri;
  final bool? openNow;
  final List<String> weekdayDescriptions;
  final String? phone;
  final String? website;
  final List<GoogleBusinessPhoto> photos;
  final List<GoogleBusinessReview> reviews;
  final String level;
  final String attribution;

  const GoogleBusiness({
    required this.placeId,
    required this.name,
    this.category,
    this.address,
    this.shortAddress,
    this.latitude,
    this.longitude,
    this.rating,
    this.reviewCount,
    this.priceLevel,
    this.businessStatus,
    this.googleMapsUri,
    this.openNow,
    this.weekdayDescriptions = const [],
    this.phone,
    this.website,
    this.photos = const [],
    this.reviews = const [],
    this.level = 'basic',
    this.attribution = 'Powered by Google',
  });

  bool get hasRating => rating != null && rating! > 0;
  bool get hasReviews => reviews.isNotEmpty;
  bool get hasHours => weekdayDescriptions.isNotEmpty;
  bool get isFull => level == 'full';
  bool get isPermanentlyClosed => businessStatus == 'CLOSED_PERMANENTLY';

  factory GoogleBusiness.fromJson(Map<String, dynamic> json) => GoogleBusiness(
        placeId: json['placeId'] as String? ?? '',
        name: json['name'] as String? ?? '',
        category: json['category'] as String?,
        address: json['address'] as String?,
        shortAddress: json['shortAddress'] as String?,
        latitude: (json['latitude'] as num?)?.toDouble(),
        longitude: (json['longitude'] as num?)?.toDouble(),
        rating: (json['rating'] as num?)?.toDouble(),
        reviewCount: (json['reviewCount'] as num?)?.toInt(),
        priceLevel: json['priceLevel'] as String?,
        businessStatus: json['businessStatus'] as String?,
        googleMapsUri: json['googleMapsUri'] as String?,
        openNow: json['openNow'] as bool?,
        weekdayDescriptions:
            (json['weekdayDescriptions'] as List?)?.whereType<String>().toList() ?? const [],
        phone: json['phone'] as String?,
        website: json['website'] as String?,
        photos: (json['photos'] as List?)
                ?.whereType<Map<String, dynamic>>()
                .map(GoogleBusinessPhoto.fromJson)
                .toList() ??
            const [],
        reviews: (json['reviews'] as List?)
                ?.whereType<Map<String, dynamic>>()
                .map(GoogleBusinessReview.fromJson)
                .toList() ??
            const [],
        level: json['level'] as String? ?? 'basic',
        attribution: json['attribution'] as String? ?? 'Powered by Google',
      );
}

/// Envelope returned by `GET /specials/:id/business`.
///
/// `manual` — the Special has no Google Place ID (admin-entered only).
/// `googleAvailable` — Google responded; when false the cached identity may
/// still be present so the Special keeps working (spec §21).
class GoogleBusinessResult {
  final GoogleBusiness? business;
  final bool googleAvailable;
  final bool manual;
  final String? error;

  const GoogleBusinessResult({
    this.business,
    this.googleAvailable = true,
    this.manual = false,
    this.error,
  });

  static const GoogleBusinessResult unavailable = GoogleBusinessResult(
    googleAvailable: false,
    error: 'Business information is currently unavailable.',
  );

  factory GoogleBusinessResult.fromJson(Map<String, dynamic> json) {
    final raw = json['business'];
    return GoogleBusinessResult(
      business: raw is Map<String, dynamic> ? GoogleBusiness.fromJson(raw) : null,
      googleAvailable: json['googleAvailable'] as bool? ?? true,
      manual: json['manual'] as bool? ?? false,
      error: json['error'] as String?,
    );
  }
}

/// Reviews heading copy: "4.6 · 1,284 reviews" — digits grouped manually so
/// no intl locale data is required.
String reviewCountLabel(int count) {
  final digits = count.toString();
  final buffer = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) buffer.write(',');
    buffer.write(digits[i]);
  }
  return '$buffer reviews';
}
