import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter/foundation.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'auth_service.dart';
import 'device_fingerprint.dart';

/// Centralized HTTP configuration for the driver app. Identical lifecycle
/// to the rider app: `main()` must `await ApiService.init()` BEFORE any
/// request is allowed. Accessing [ApiService.dio] before [init] completes
/// throws a [StateError] so misordering crashes loudly instead of silently
/// issuing requests against a stale base URL.
class ApiService {
  ApiService._();

  static final GlobalKey<NavigatorState> navigatorKey = GlobalKey<NavigatorState>();

  static bool _initialized = false;
  static Dio? _dio;

  /// Canonical base URL. We deliberately use the dotenv value WITHOUT a
  /// trailing slash so callers can use path-only routes (`auth/oauth`)
  /// without producing `//` in the final URL.
  static String get baseUrl {
    final env = dotenv.env['API_BASE_URL'] ?? 'https://netride.onrender.com';
    return '$env/api';
  }

  /// WebSocket base URL derived from [baseUrl] by stripping everything from
  /// the first `/api` segment onward. Identical to the rider getter so
  /// HTTP + WS gateways stay in lock-step across both apps.
  static String get socketBaseUrl {
    final env = dotenv.env['API_BASE_URL'] ?? 'https://netride.onrender.com';
    final idx = env.indexOf('/api');
    return idx >= 0 ? env.substring(0, idx) : env;
  }

  /// Returns the configured [Dio]. Throws if [init] was never called.
  static Dio get dio {
    if (!_initialized || _dio == null) {
      throw StateError(
        'ApiService.dio was accessed before ApiService.init() completed. '
        'Ensure main() awaits ApiService.init() before runApp().',
      );
    }
    return _dio!;
  }

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

        // Tag every request with our stable device id so the backend can
        // detect new-device sign-ins and force a fresh face verification.
        if (options.headers['X-Device-Id'] == null) {
          try {
            final did = await DeviceFingerprint.getOrCreate();
            options.headers['X-Device-Id'] = did;
          } catch (_) {
            // SharedPreferences unavailable — leave header unset.
          }
        }

        return handler.next(options);
      },
      onError: (DioException e, handler) async {
        if (e.response?.statusCode == 401) {
          // Single-flight guard: if the request was already retried once
          // after a backend sync and STILL 401s, do not enter recovery again.
          if (e.requestOptions.headers['X-Already-Retried'] == 'true') {
            debugPrint('[API] ⚠️ Already-retried 401 — propagating without recovery.');
            return handler.next(e);
          }
          debugPrint('[API] 401 Unauthorized detected for ${e.requestOptions.path}');

          // ONLY attempt sync/logout if we actually sent a token. 
          // If we didn't send a token, the 401 is expected and should be handled by the caller.
          final sentToken = e.requestOptions.headers['Authorization'];
          if (sentToken == null || sentToken.toString().isEmpty) {
            debugPrint('[API] ⚠️ 401 received but no token was sent. Not performing auto-logout.');
            return handler.next(e);
          }

          final hasSupabaseSession = Supabase.instance.client.auth.currentSession != null;

          if (hasSupabaseSession) {
            debugPrint('[API] 🔄 Active Supabase session found. Attempting backend sync...');
            final success = await AuthService.syncWithBackend();
            if (success) {
              debugPrint('[API] 🔄 Sync successful. Retrying original request...');
              final prefs = await SharedPreferences.getInstance();
              final newToken = prefs.getString('jwt_token');
              e.requestOptions.headers['Authorization'] = 'Bearer $newToken';

              // Single-flight guard: prevent recursive interceptor triggering
              // if the retry also returns 401. Short-circuited in onError.
              e.requestOptions.headers['X-Already-Retried'] = 'true';

              final response = await client.fetch(e.requestOptions);
              return handler.resolve(response);
            }
          }

          debugPrint('[API] ❌ Sync failed or no session. Clearing session and redirecting to login...');
          await AuthService.logout();

          // Force redirect to login
          navigatorKey.currentState?.pushNamedAndRemoveUntil('/login', (route) => false);
        }
        return handler.next(e);
      },
    ));

    _dio = client;
    _initialized = true;
  }

  static Future<Response> rateRide({
    required String rideId,
    required int rating,
    String? reviewText,
  }) async {
    return await dio.post('ride/rate', data: {
      'ride_id': rideId,
      'rating': rating,
      'review_text': reviewText,
    });
  }
}
