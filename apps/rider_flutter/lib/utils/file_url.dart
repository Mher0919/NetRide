import '../services/api_service.dart';

/// Resolves any /api/files/{id} URL — relative or absolute — to a
/// fully-qualified URL that works from the current environment (emulator,
/// device, web).
///
/// Strips the trailing /api from the API base URL to avoid double /api.
/// Absolute URLs are returned as-is only when they do NOT point to our own
/// /api/files/ endpoint (to handle stale localhost URLs that were stored
/// during development).
String resolveFileUrl(String url) {
  // Already a clean relative path — simple case.
  if (url.startsWith('/api/files/')) {
    final base = ApiService.baseUrl.replaceAll(RegExp(r'/api/?$'), '');
    return '$base$url';
  }

  // Full URL that points to our own /api/files/ endpoint
  // (e.g. http://localhost:3000/api/files/xxx was stored during development).
  // Re-resolve it so it works on emulator/device where localhost doesn't
  // map to the host machine.
  final match = RegExp(r'^https?://[^/]+(/api/files/)').firstMatch(url);
  if (match != null) {
    final base = ApiService.baseUrl.replaceAll(RegExp(r'/api/?$'), '');
    return '$base${match.group(1)}${url.substring(match.end)}';
  }

  return url;
}

/// Resolves any backend-relative URL (e.g. the signed Google photo proxy at
/// `/api/places/photo?...`) to a fully-qualified URL for the current
/// environment. Stale absolute URLs pointing at our own /api/ endpoints are
/// re-resolved so development hosts never leak into production builds.
String resolveApiUrl(String url) {
  if (url.isEmpty) return url;
  if (url.startsWith('/api/')) {
    final base = ApiService.baseUrl.replaceAll(RegExp(r'/api/?$'), '');
    return '$base$url';
  }
  final match = RegExp(r'^https?://[^/]+(/api/)').firstMatch(url);
  if (match != null) {
    final base = ApiService.baseUrl.replaceAll(RegExp(r'/api/?$'), '');
    return '$base${match.group(1)}${url.substring(match.end)}';
  }
  return url;
}
