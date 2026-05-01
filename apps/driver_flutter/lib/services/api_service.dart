import 'dart:io';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

class ApiService {
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
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 10),
    ),
  );

  static Future<void> init() async {
    dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) async {
        final prefs = await SharedPreferences.getInstance();
        final token = prefs.getString('jwt_token');
        if (token != null) {
          options.headers['Authorization'] = 'Bearer $token';
          debugPrint('[API] Sending request to ${options.path} with token');
        } else {
          debugPrint('[API] Sending request to ${options.path} WITHOUT token');
        }
        return handler.next(options);
      },
      onError: (e, handler) {
        debugPrint('[API] Error for ${e.requestOptions.path}: [${e.response?.statusCode}] ${e.response?.data}');
        return handler.next(e);
      },
    ));
  }
}
