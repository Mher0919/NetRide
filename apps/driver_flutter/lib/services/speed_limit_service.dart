// apps/driver_flutter/lib/services/speed_limit_service.dart
//
// Fetches the legal speed limit for the driver's current position from the
// backend (which proxies Google Roads `speedLimits`). NavigationService
// refreshes it when the driver turns onto a new street; failures are silent
// and the HUD keeps the last known limit.

import 'package:dio/dio.dart';
import 'package:latlong2/latlong.dart';

import 'api_service.dart';

class SpeedLimitResult {
  final int? speedLimitMph;
  final String? roadName;
  final String source;

  const SpeedLimitResult({
    this.speedLimitMph,
    this.roadName,
    this.source = 'unavailable',
  });

  static const unavailable = SpeedLimitResult();
}

class SpeedLimitService {
  static Future<SpeedLimitResult> lookup(LatLng position) async {
    try {
      final response = await ApiService.dio.get(
        '/navigation/speed-limit',
        queryParameters: {'lat': position.latitude, 'lng': position.longitude},
        options: Options(
          sendTimeout: const Duration(seconds: 4),
          receiveTimeout: const Duration(seconds: 4),
        ),
      );
      final data = response.data;
      if (data is! Map) return SpeedLimitResult.unavailable;
      final raw = data['speedLimitMph'];
      final mph = raw is num ? raw.round() : int.tryParse('$raw');
      if (mph == null || mph <= 0) return SpeedLimitResult.unavailable;
      return SpeedLimitResult(
        speedLimitMph: mph,
        roadName: data['roadName']?.toString(),
        source: data['source']?.toString() ?? 'google',
      );
    } catch (_) {
      return SpeedLimitResult.unavailable;
    }
  }
}
