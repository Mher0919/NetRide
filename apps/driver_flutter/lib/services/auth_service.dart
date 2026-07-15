import 'dart:io';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'api_service.dart';
import '../providers/driver_provider.dart';
import '../cache/cache_service.dart';

class AuthService {
  static final ValueNotifier<bool> isAuthenticatedNotifier = ValueNotifier<bool>(false);

  static void _updateProvider(String token) {
    try {
      final context = ApiService.navigatorKey.currentContext;
      if (context != null) {
        Provider.of<DriverProvider>(context, listen: false).updateToken(token);
      }
    } catch (e) {
      debugPrint('[AuthService] ⚠️ Could not update DriverProvider: $e');
    }
  }

  static Future<Map<String, dynamic>> loginWithOAuth({
    required String email,
    required String fullName,
    String? profileImageUrl,
    required String role,
    String? token,
  }) async {
    try {
      final response = await ApiService.dio.post('/auth/oauth', data: {
        'email': email,
        'full_name': fullName,
        'profile_image_url': profileImageUrl,
        'role': role,
        'token': token,
      });

      if (response.statusCode == 200 || response.statusCode == 201) {
        final data = response.data;
        final prefs = await SharedPreferences.getInstance();
        final jwtToken = data['token'];
        if (jwtToken != null) {
          await prefs.setString('jwt_token', jwtToken);
          await prefs.setString('user_id', data['user']['id']);
          await prefs.setString('user_role', data['user']['role']);
          debugPrint('[AuthService] Token saved successfully');
          _updateProvider(jwtToken);
          isAuthenticatedNotifier.value = true;
        } else {
          debugPrint('[AuthService] No token found in response');
        }
        return data;
      }
      throw Exception('Login failed');
    } catch (e) {
      rethrow;
    }
  }

  static Future<void> requestOTP(String email) async {
    try {
      await ApiService.dio.post('/auth/request-otp', data: {'email': email});
    } catch (e) {
      rethrow;
    }
  }

  static Future<Map<String, dynamic>> requestPhoneOTP(String phoneNumber) async {
    try {
      final response = await ApiService.dio.post('/auth/request-phone-otp', data: {
        'phone_number': phoneNumber,
        'role': 'DRIVER',
      });
      return response.data is Map ? Map<String, dynamic>.from(response.data as Map) : {};
    } catch (e) {
      rethrow;
    }
  }

  static Future<Map<String, dynamic>> verifyPhoneOTP({
    required String phoneNumber,
    required String code,
  }) async {
    try {
      final response = await ApiService.dio.post('/auth/verify-phone-otp', data: {
        'phone_number': phoneNumber,
        'code': code,
        'role': 'DRIVER',
      });

      if (response.statusCode == 200 || response.statusCode == 201) {
        return response.data;
      }
      throw Exception('Phone verification failed');
    } catch (e) {
      rethrow;
    }
  }

  static Future<Map<String, dynamic>> verifyOTP({
    required String email,
    required String code,
    String? fullName,
    String? role,
  }) async {
    try {
      final response = await ApiService.dio.post('/auth/verify-otp', data: {
        'email': email,
        'code': code,
        if (fullName != null) 'full_name': fullName,
        if (role != null) 'role': role,
      });

      if (response.statusCode == 200 || response.statusCode == 201) {
        final data = response.data;
        final prefs = await SharedPreferences.getInstance();
        final jwtToken = data['token'];
        if (jwtToken != null) {
          await prefs.setString('jwt_token', jwtToken);
          await prefs.setString('user_id', data['user']['id']);
          await prefs.setString('user_role', data['user']['role']);
          debugPrint('[AuthService] Token saved successfully');
          _updateProvider(jwtToken);
          isAuthenticatedNotifier.value = true;
        } else {
          debugPrint('[AuthService] No token found in response');
        }
        return data;
      }
      throw Exception('Verification failed');
    } catch (e) {
      rethrow;
    }
  }

  static Future<Map<String, dynamic>> signupWithPassword({
    required String email,
    required String fullName,
    required String password,
    required String role,
  }) async {
    try {
      final response = await ApiService.dio.post('/auth/signup-password', data: {
        'email': email,
        'full_name': fullName,
        'password': password,
        'role': role,
      });

      if (response.statusCode == 200 || response.statusCode == 201) {
        final data = response.data;
        final prefs = await SharedPreferences.getInstance();
        final jwtToken = data['token'];
        if (jwtToken != null) {
          await prefs.setString('jwt_token', jwtToken);
          await prefs.setString('user_id', data['user']['id']);
          await prefs.setString('user_role', data['user']['role']);
          debugPrint('[AuthService] Token saved successfully');
          _updateProvider(jwtToken);
          isAuthenticatedNotifier.value = true;
        } else {
          debugPrint('[AuthService] No token found in response');
        }
        return data;
      }
      throw Exception('Signup failed');
    } catch (e) {
      rethrow;
    }
  }

  static Future<Map<String, dynamic>> loginWithPassword({
    required String email,
    required String password,
  }) async {
    try {
      final response = await ApiService.dio.post('/auth/login-password', data: {
        'email': email,
        'password': password,
      });

      if (response.statusCode == 200 || response.statusCode == 201) {
        final data = response.data;
        if (data['otp_required'] == true) {
          return data;
        }

        final prefs = await SharedPreferences.getInstance();
        final jwtToken = data['token'];
        if (jwtToken != null) {
          await prefs.setString('jwt_token', jwtToken);
          await prefs.setString('user_id', data['user']['id']);
          await prefs.setString('user_role', data['user']['role']);
          debugPrint('[AuthService] Token saved successfully');
          _updateProvider(jwtToken);
          isAuthenticatedNotifier.value = true;
        } else {
          debugPrint('[AuthService] No token found in response');
        }
        return data;
      }
      throw Exception('Login failed');
    } catch (e) {
      rethrow;
    }
  }

  static Future<void> changePassword({String? currentPassword, required String newPassword}) async {
    try {
      await ApiService.dio.post('/auth/change-password', data: {
        if (currentPassword != null) 'currentPassword': currentPassword,
        'newPassword': newPassword,
      });
    } catch (e) {
      rethrow;
    }
  }

  static Future<void> requestPasswordChange(String currentPassword) async {
    try {
      await ApiService.dio.post('/auth/request-password-change', data: {'currentPassword': currentPassword});
    } catch (e) {
      rethrow;
    }
  }

  static Future<void> deleteAccount() async {
    try {
      await ApiService.dio.delete('/auth/account');
      await logout();
    } catch (e) {
      rethrow;
    }
  }

  static Future<void> deactivateAccount() async {
    try {
      await ApiService.dio.post('/auth/deactivate-account');
      await logout();
    } catch (e) {
      rethrow;
    }
  }

  static Future<void> forgotPassword(String email) async {
    try {
      await ApiService.dio.post('/auth/forgot-password', data: {'email': email});
    } catch (e) {
      rethrow;
    }
  }

  static Future<void> resetPassword(String token, String newPassword) async {
    try {
      await ApiService.dio.post('/auth/reset-password', data: {
        'token': token,
        'newPassword': newPassword,
      });
    } catch (e) {
      rethrow;
    }
  }

  static Future<void> requestEmailChange(String newEmail) async {
    try {
      await ApiService.dio.post('/user/request-email-change', data: {'newEmail': newEmail});
    } catch (e) {
      rethrow;
    }
  }

  static Future<String> uploadImage(File file) async {
    try {
      final bytes = await file.readAsBytes();
      final base64Image = base64Encode(bytes);
      final filename = file.path.split(Platform.pathSeparator).last;
      final mimetype = _getMimeType(filename);

      final response = await ApiService.dio.post('/upload', data: {
        'image': base64Image,
        'mimetype': mimetype,
        'filename': filename,
      });
      return response.data['url'];
    } catch (e) {
      debugPrint('Upload error: $e');
      rethrow;
    }
  }

  static String _getMimeType(String filename) {
    if (filename.endsWith('.png')) return 'image/png';
    if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) return 'image/jpeg';
    if (filename.endsWith('.gif')) return 'image/gif';
    return 'image/jpeg';
  }

  static Future<Map<String, dynamic>> getDriverProfile() async {
    try {
      final response = await ApiService.dio.get('/driver/profile');
      return response.data;
    } catch (e) {
      rethrow;
    }
  }

  static Future<Map<String, dynamic>> getOnboardingProgress() async {
    try {
      final response = await ApiService.dio.get('/driver/onboarding/progress');
      return response.data;
    } catch (e) {
      rethrow;
    }
  }

  static Future<Map<String, dynamic>> saveOnboardingStep(int step, Map<String, dynamic> data) async {
    try {
      final response = await ApiService.dio.post('/driver/onboarding/step', data: {
        'step': step,
        'data': data,
      });
      return response.data;
    } catch (e) {
      rethrow;
    }
  }

  static Future<Map<String, dynamic>> completeOnboarding() async {
    try {
      final response = await ApiService.dio.post('/driver/onboarding/complete');
      return response.data;
    } catch (e) {
      rethrow;
    }
  }

  static Future<void> onboardDriver(Map<String, dynamic> data) async {
    try {
      await ApiService.dio.post('/driver/onboard', data: data);
    } catch (e) {
      rethrow;
    }
  }

  static Future<List<dynamic>> getVehicles() async {
    try {
      final response = await ApiService.dio.get('/driver/vehicles');
      return response.data;
    } catch (e) {
      rethrow;
    }
  }

  static Future<List<int>> getVehicleYears() async {
    try {
      final response = await ApiService.dio.get('/driver/vehicle-models/years');
      return List<int>.from(response.data);
    } catch (e) {
      rethrow;
    }
  }

  static Future<List<String>> getVehicleMakes(int year) async {
    try {
      final response = await ApiService.dio.get('/driver/vehicle-models/makes');
      return List<String>.from(response.data);
    } catch (e) {
      rethrow;
    }
  }

  static Future<List<String>> getVehicleModels(String make, int year) async {
    try {
      final response = await ApiService.dio.get('/driver/vehicle-models/models', queryParameters: {
        'make': make,
      });
      return List<String>.from(response.data);
    } catch (e) {
      rethrow;
    }
  }

  static Future<void> logout() async {
    // Clear all user-scoped cached data first (privacy/security)
    try {
      await CacheService.instance.clearAll();
      debugPrint('[AUTH] User cache cleared on logout');
    } catch (e) {
      debugPrint('[AUTH] Cache clear error: $e');
    }

    try {
      await Supabase.instance.client.auth.signOut();
    } catch (e) {
      debugPrint('Supabase signout error: $e');
    }
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('jwt_token');
    await prefs.remove('user_id');
    await prefs.remove('user_role');
    isAuthenticatedNotifier.value = false;
  }

  static Future<bool> syncWithBackend() async {
    try {
      final supabase = Supabase.instance.client;
      final session = supabase.auth.currentSession;
      if (session == null) return false;

      // Refresh the session to ensure we have a fresh, valid accessToken
      debugPrint('[AUTH SYNC] 🔄 Refreshing Supabase session...');
      final refreshRes = await supabase.auth.refreshSession();
      final currentSession = refreshRes.session;
      if (currentSession == null) return false;

      final user = currentSession.user;
      final metadata = user.userMetadata ?? {};
      
      debugPrint('[AUTH SYNC] 🔄 Syncing with backend for ${user.email}...');

      final res = await loginWithOAuth(
        email: user.email!,
        fullName: metadata['full_name'] ?? metadata['name'] ?? 'NetRide Driver',
        profileImageUrl: metadata['avatar_url'] ?? metadata['picture'],
        role: 'DRIVER',
        token: currentSession.accessToken,
      );

      if (res['token'] != null) {
        debugPrint('[AUTH SYNC] ✅ Sync successful');
        isAuthenticatedNotifier.value = true;
        return true;
      }
      return false;
    } catch (e) {
      debugPrint('[AUTH SYNC] ❌ Sync failed: $e');
      return false;
    }
  }

  static bool isJwtExpired(String token) {
    try {
      final parts = token.split('.');
      if (parts.length != 3) return true;
      
      String payload = parts[1];
      int padding = 4 - (payload.length % 4);
      if (padding > 0 && padding < 4) {
        payload += '=' * padding;
      }
      
      final String decoded = utf8.decode(base64Url.decode(payload));
      final Map<String, dynamic> json = jsonDecode(decoded);
      
      if (json.containsKey('exp')) {
        final int exp = json['exp'];
        final DateTime expiryDate = DateTime.fromMillisecondsSinceEpoch(exp * 1000);
        // 1 minute buffer
        return DateTime.now().add(const Duration(minutes: 1)).isAfter(expiryDate);
      }
      return true;
    } catch (e) {
      return true;
    }
  }

  static Future<bool> isAuthenticated() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString('jwt_token');
    if (token == null) return false;
    return !isJwtExpired(token);
  }
}
