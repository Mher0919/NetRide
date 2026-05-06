import 'dart:io';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter/foundation.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'auth_service.dart';

class ApiService {
  static final GlobalKey<NavigatorState> navigatorKey = GlobalKey<NavigatorState>();

  static final String _baseUrl = kIsWeb 
      ? 'http://localhost:3000/api/'
      : Platform.isAndroid 
          ? 'http://10.0.2.2:3000/api/' 
          : 'http://localhost:3000/api/';

  static final Dio dio = Dio(
    BaseOptions(
      baseUrl: _baseUrl,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      connectTimeout: const Duration(seconds: 30),
      receiveTimeout: const Duration(seconds: 30),
    ),
  );

  static Future<void> init() async {
    dio.interceptors.clear(); // Clear to avoid duplicates
    dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) async {
        final prefs = await SharedPreferences.getInstance();
        final token = prefs.getString('jwt_token');

        debugPrint('[API DEBUG] 🛰️ ${options.method} ${options.baseUrl}${options.path}');

        if (token != null && token.isNotEmpty) {
          options.headers['Authorization'] = 'Bearer $token';
        } else {
          debugPrint('[API DEBUG] ⚠️ NO TOKEN FOUND IN PREFS for ${options.path}');
        }
        return handler.next(options);
      },
      onError: (DioException e, handler) async {
        if (e.response?.statusCode == 401) {
          debugPrint('[API] 401 Unauthorized detected for ${e.requestOptions.path}');

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
    ));
  }
}
