import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter/foundation.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'auth_service.dart';

/// Centralized HTTP configuration for the rider app.
///
/// This service is the single owner of the [Dio] instance. It is
/// initialized exactly once during app boot via [init], AFTER
/// [dotenv.load] has populated environment values. Until [init] is
/// called, attempts to access [dio] throw a clear [StateError] so
/// that race conditions fail loudly instead of silently using a
/// stale base URL or a missing interceptor.
///
/// The interceptor chain is responsible for:
///   * Attaching the JWT bearer for every call (when present).
///   * Detecting 401 responses and synchronously refreshing the
///     backend session via [AuthService.syncWithBackend] before
///     retrying the original request exactly once.
class ApiService {
  ApiService._();

  static final GlobalKey<NavigatorState> navigatorKey = GlobalKey<NavigatorState>();

  /// Whether [init] has completed. Useful for sanity-checking callers.
  static bool _initialized = false;

  /// Lazily-created Dio instance. The first access AFTER [init] has
  /// completed returns the configured client; accessing it before
  /// [init] throws a [StateError] to surface ordering bugs early.
  static Dio? _dio;

  /// Canonical base URL (with trailing `/api/`).
  ///
  /// Always resolves via dotenv so that all environments (dev / staging
  /// / prod) reach the correct gateway. The hard-coded fallback is
  /// the production onrender deployment, identical to the previous
  /// behavior so staged rollouts never regress.
  static String get baseUrl {
    final env = dotenv.env['API_BASE_URL'] ?? 'https://netride.onrender.com';
    return '$env/api/';
  }

  /// WebSocket base URL derived from [baseUrl] by stripping everything from
  /// the first `/api` segment onward. This guarantees HTTP and WS connect
  /// to the same gateway irrespective of versioned paths like `/api/v1/`.
  static String get socketBaseUrl {
    final env = dotenv.env['API_BASE_URL'] ?? 'https://netride.onrender.com';
    final idx = env.indexOf('/api');
    return idx >= 0 ? env.substring(0, idx) : env;
  }

  /// Returns the configured Dio. Throws if [init] was never called.
  static Dio get dio {
    if (!_initialized || _dio == null) {
      throw StateError(
        'ApiService.dio was accessed before ApiService.init() completed. '
        'Ensure main() awaits ApiService.init() before runApp().',
      );
    }
    return _dio!;
  }

  /// One-time initialization. Idempotent — safe to call multiple times.
  static Future<void> init() async {
    if (_initialized && _dio != null) return;

    final client = Dio(
      BaseOptions(
        baseUrl: baseUrl,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        connectTimeout: const Duration(seconds: 30),
        receiveTimeout: const Duration(seconds: 30),
        sendTimeout: const Duration(seconds: 30),
      ),
    );

    client.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) async {
        final prefs = await SharedPreferences.getInstance();
        final token = prefs.getString('jwt_token');

        debugPrint('[API DEBUG] 🛰️ ${options.method} ${options.uri}');

        if (token != null && token.isNotEmpty) {
          options.headers['Authorization'] = 'Bearer $token';
        } else if (!options.path.startsWith('auth/')) {
          debugPrint('[API DEBUG] ⚠️ NO TOKEN FOUND IN PREFS for ${options.path}');
        }
        return handler.next(options);
      },
      onError: (DioException e, handler) async {
        // Only attempt recovery on a true 401 with a token that we sent.
        if (e.response?.statusCode == 401) {
          // Single-flight guard: if the request was already retried once
          // after a backend sync and STILL 401s, do not enter recovery again.
          if (e.requestOptions.headers['X-Already-Retried'] == 'true') {
            debugPrint('[API] ⚠️ Already-retried 401 — propagating without recovery.');
            return handler.next(e);
          }
          debugPrint('[API] 401 Unauthorized detected for ${e.requestOptions.path}');

          final sentToken = e.requestOptions.headers['Authorization'];
          if (sentToken == null || sentToken.toString().isEmpty) {
            debugPrint('[API] ⚠️ 401 received but no token was sent — not auto-logging out.');
            return handler.next(e);
          }

          final hasSupabaseSession =
              Supabase.instance.client.auth.currentSession != null;

          if (hasSupabaseSession) {
            debugPrint('[API] 🔄 Active Supabase session found. Attempting backend sync...');
            final success = await AuthService.syncWithBackend();
            if (success) {
              debugPrint('[API] 🔄 Sync successful. Retrying original request...');
              try {
                final prefs = await SharedPreferences.getInstance();
                final newToken = prefs.getString('jwt_token');
                e.requestOptions.headers['Authorization'] = 'Bearer $newToken';
                // Single-flight guard: prevent recursive interceptor triggering
                // if the retry also returns 401. Short-circuited in onError.
                e.requestOptions.headers['X-Already-Retried'] = 'true';
                final response = await client.fetch(e.requestOptions);
                return handler.resolve(response);
              } catch (retryErr) {
                debugPrint('[API] ❌ Retry after sync failed: $retryErr');
                // Fall through to cleanup below.
              }
            }
          }

          debugPrint('[API] ❌ Sync failed or no session. Clearing and redirecting to login.');
          await AuthService.logout();
          navigatorKey.currentState
              ?.pushNamedAndRemoveUntil('/login', (route) => false);
        }
        return handler.next(e);
      },
    ));

    _dio = client;
    _initialized = true;
  }

  /// Submit a rating for a completed ride.
  static Future<Response> rateRide({
    required String rideId,
    required int rating,
    String? reviewText,
    bool? favorite,
  }) async {
    return await dio.post('ride/rate', data: {
      'ride_id': rideId,
      'rating': rating,
      'review_text': reviewText,
      'favorite': favorite ?? false,
    });
  }
}
