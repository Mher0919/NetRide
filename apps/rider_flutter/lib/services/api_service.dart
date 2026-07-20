import 'dart:io';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter/foundation.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'auth_service.dart';

class ApiService {
  static final GlobalKey<NavigatorState> navigatorKey = GlobalKey<NavigatorState>();
  
  static String get baseUrl {
    return 'https://netride.onrender.com/api/';
  }

  static final Dio dio = Dio(
    BaseOptions(
      baseUrl: baseUrl,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      connectTimeout: const Duration(seconds: 30),
      receiveTimeout: const Duration(seconds: 30),
    ),
  );

  static Future<void> init() async {
    dio.interceptors.clear();
    dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) async {
        final prefs = await SharedPreferences.getInstance();
        final token = prefs.getString('jwt_token');

        debugPrint('[API DEBUG] 🛰️ ${options.method} ${options.uri}');

        if (token != null && token.isNotEmpty) {
          options.headers['Authorization'] = 'Bearer $token';
          // debugPrint('[API DEBUG] ✅ Token attached');
        } else if (!options.path.startsWith('auth/')) {
          debugPrint('[API DEBUG] ⚠️ NO TOKEN FOUND IN PREFS for ${options.path}');
        }
        return handler.next(options);
      },
      onError: (DioException e, handler) async {
        if (e.response?.statusCode == 401) {
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
              
              // Use fetch to retry the request
              final response = await dio.fetch(e.requestOptions);
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
    ));  }

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
