import 'api_service.dart';

class UserService {
  static Future<Map<String, dynamic>> getProfile() async {
    try {
      final response = await ApiService.dio.get('user/profile');
      return response.data;
    } catch (e) {
      rethrow;
    }
  }

  static Future<void> updateProfile(Map<String, dynamic> data) async {
    try {
      await ApiService.dio.patch('user/profile', data: data);
    } catch (e) {
      rethrow;
    }
  }
}
