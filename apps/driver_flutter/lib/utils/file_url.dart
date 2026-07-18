import '../services/api_service.dart';

/// Resolves a relative /api/files/{id} URL to a fully-qualified URL.
/// Strips the trailing /api from the base URL to avoid double /api.
/// Absolute URLs are returned unchanged.
String resolveFileUrl(String url) {
  if (url.startsWith('/api/files/')) {
    final base = ApiService.baseUrl.replaceAll(RegExp(r'/api/?$'), '');
    return '$base$url';
  }
  return url;
}
