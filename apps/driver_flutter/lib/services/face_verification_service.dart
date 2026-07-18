import 'dart:io';
import 'package:dio/dio.dart';
import 'package:http_parser/http_parser.dart';
import 'package:path/path.dart' as p;
import 'api_service.dart';
import 'device_fingerprint.dart';

/// Why the server says we need to re-verify (mirrors the backend enum).
enum FaceCheckReason {
  flagged,
  enrollment,
  firstTime,
  expired,
  newDevice,
  locationJump,
}

/// High-level state derived from the last server response.
enum FaceCheckStatus { clear, needsCheck, flagged }

class FaceCheckDecision {
  final bool required;
  final FaceCheckReason reason;
  final FaceCheckStatus status;
  final DateTime? lastFaceCheckAt;

  const FaceCheckDecision({
    required this.required,
    required this.reason,
    required this.status,
    required this.lastFaceCheckAt,
  });

  factory FaceCheckDecision.fromJson(Map<String, dynamic> json) {
    return FaceCheckDecision(
      required: json['required'] == true,
      reason: _parseReason(json['reason'] as String?),
      status: _parseStatus(json['faceCheckStatus'] as String?),
      lastFaceCheckAt: json['lastFaceCheckAt'] != null
          ? DateTime.tryParse(json['lastFaceCheckAt'].toString())
          : null,
    );
  }

  static FaceCheckReason _parseReason(String? raw) {
    switch (raw) {
      case 'flagged':
        return FaceCheckReason.flagged;
      case 'enrollment':
        return FaceCheckReason.enrollment;
      case 'first_time':
        return FaceCheckReason.firstTime;
      case '12h_expired':
        return FaceCheckReason.expired;
      case 'new_device':
        return FaceCheckReason.newDevice;
      case 'location_jump':
        return FaceCheckReason.locationJump;
      default:
        return FaceCheckReason.firstTime;
    }
  }

  static FaceCheckStatus _parseStatus(String? raw) {
    switch (raw) {
      case 'FLAGGED':
        return FaceCheckStatus.flagged;
      case 'PENDING_REVIEW':
        return FaceCheckStatus.needsCheck;
      case 'CLEAR':
      default:
        return FaceCheckStatus.clear;
    }
  }
}

class FaceVerifyResult {
  final bool passed;
  final bool match;
  final double score;
  final String? reason;
  final String? clipUrl;
  final String? eventId;
  final Map<String, dynamic>? liveness;
  final Map<String, dynamic>? quality;
  final String? selfieUrl;

  const FaceVerifyResult({
    required this.passed,
    required this.match,
    required this.score,
    this.reason,
    this.clipUrl,
    this.eventId,
    this.liveness,
    this.quality,
    this.selfieUrl,
  });

  factory FaceVerifyResult.fromJson(Map<String, dynamic> json) {
    return FaceVerifyResult(
      passed: (json['status'] ?? '') == 'PASS',
      match: json['match'] == true,
      score: (json['score'] as num?)?.toDouble() ?? 0.0,
      reason: json['reason'] as String?,
      clipUrl: json['clipUrl'] as String?,
      eventId: json['eventId'] as String?,
      liveness: json['liveness'] as Map<String, dynamic>?,
      quality: json['quality'] as Map<String, dynamic>?,
      selfieUrl: json['selfieUrl'] as String?,
    );
  }
}

/// Talks to `/api/face/check-required` and `/api/face/verify-image`.
class FaceVerificationService {
  /// Query the server to decide whether the driver must re-verify before
  /// going online. Optional lat/lng let the server compute the >5mi jump
  /// against the last offline location.
  static Future<FaceCheckDecision> isCheckRequired({
    double? lat,
    double? lng,
  }) async {
    final deviceId = await DeviceFingerprint.getOrCreate();
    final response = await ApiService.dio.get(
      '/face/check-required',
      queryParameters: {
        if (lat != null) 'lat': lat,
        if (lng != null) 'lng': lng,
      },
      options: Options(headers: {'X-Device-Id': deviceId}),
    );
    return FaceCheckDecision.fromJson(response.data as Map<String, dynamic>);
  }

  /// Upload a recorded clip + reference JPEG for verification (legacy).
  static Future<FaceVerifyResult> verify({
    required File clipFile,
    required File referenceFile,
    double? lat,
    double? lng,
  }) async {
    final deviceId = await DeviceFingerprint.getOrCreate();

    final clipName = p.basename(clipFile.path);
    final refName = p.basename(referenceFile.path);

    final formData = FormData.fromMap({
      'video': await MultipartFile.fromFile(
        clipFile.path,
        filename: clipName,
        contentType: MediaType('video', 'mp4'),
      ),
      'reference': await MultipartFile.fromFile(
        referenceFile.path,
        filename: refName,
        contentType: MediaType('image', 'jpeg'),
      ),
      if (lat != null) 'lat': lat.toString(),
      if (lng != null) 'lng': lng.toString(),
    });

    final response = await ApiService.dio.post(
      '/face/verify',
      data: formData,
      options: Options(
        headers: {
          'X-Device-Id': deviceId,
          'Content-Type': 'multipart/form-data',
        },
        receiveTimeout: const Duration(seconds: 45),
        sendTimeout: const Duration(seconds: 60),
      ),
    );

    return FaceVerifyResult.fromJson(response.data as Map<String, dynamic>);
  }

  /// Upload a single selfie image + optional reference JPEG for verification.
  ///
  /// When [referenceFile] is omitted, the server will look up the
  /// enrollment reference from the database automatically.
  static Future<FaceVerifyResult> verifyImage({
    required File selfieFile,
    File? referenceFile,
    double? lat,
    double? lng,
  }) async {
    final deviceId = await DeviceFingerprint.getOrCreate();

    final selfieName = p.basename(selfieFile.path);

    final map = <String, dynamic>{
      'selfie': await MultipartFile.fromFile(
        selfieFile.path,
        filename: selfieName,
        contentType: MediaType('image', 'jpeg'),
      ),
      if (lat != null) 'lat': lat.toString(),
      if (lng != null) 'lng': lng.toString(),
    };

    if (referenceFile != null) {
      final refName = p.basename(referenceFile.path);
      map['reference'] = await MultipartFile.fromFile(
        referenceFile.path,
        filename: refName,
        contentType: MediaType('image', 'jpeg'),
      );
    }

    final formData = FormData.fromMap(map);

    final response = await ApiService.dio.post(
      '/face/verify-image',
      data: formData,
      options: Options(
        headers: {
          'X-Device-Id': deviceId,
          'Content-Type': 'multipart/form-data',
        },
        receiveTimeout: const Duration(seconds: 30),
        sendTimeout: const Duration(seconds: 30),
      ),
    );

    return FaceVerifyResult.fromJson(response.data as Map<String, dynamic>);
  }
}
