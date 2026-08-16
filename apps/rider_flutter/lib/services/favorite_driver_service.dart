import 'api_service.dart';

class FavoriteDriverInfo {
  final String id;
  final String driverId;
  final String fullName;
  final String? profileImageUrl;
  final String? phoneNumber;
  final double rating;
  final int ratingCount;
  final DateTime addedAt;

  FavoriteDriverInfo({
    required this.id,
    required this.driverId,
    required this.fullName,
    this.profileImageUrl,
    this.phoneNumber,
    required this.rating,
    required this.ratingCount,
    required this.addedAt,
  });

  factory FavoriteDriverInfo.fromJson(Map<String, dynamic> json) {
    final driver = json['driver'] as Map<String, dynamic>?;
    final user = driver?['user'] as Map<String, dynamic>?;
    return FavoriteDriverInfo(
      id: json['id'] as String,
      driverId: json['driver_id'] as String,
      fullName: user?['full_name'] as String? ?? 'Unknown Driver',
      profileImageUrl: user?['profile_image_url'] as String?,
      phoneNumber: user?['phone_number'] as String?,
      rating: (user?['rating'] as num?)?.toDouble() ?? 5.0,
      ratingCount: (user?['rating_count'] as num?)?.toInt() ?? 0,
      addedAt: json['created_at'] != null
          ? DateTime.parse(json['created_at'] as String)
          : DateTime.now(),
    );
  }
}

class FavoriteDriverService {
  static Future<List<FavoriteDriverInfo>> getFavorites() async {
    final response = await ApiService.dio.get('user/favorites');
    final data = response.data as List;
    return data
        .map((e) => FavoriteDriverInfo.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  static Future<void> removeFavorite(String driverId) async {
    await ApiService.dio.delete('user/favorites/$driverId');
  }
}
