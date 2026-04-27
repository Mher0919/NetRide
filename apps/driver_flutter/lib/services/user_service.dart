import 'api_service.dart';

class UserService {
  static Future<Map<String, dynamic>> getProfile() async {
    try {
      final response = await ApiService.dio.get('/driver/profile');
      return response.data;
    } catch (e) {
      rethrow;
    }
  }

  static Future<void> updateProfile(Map<String, dynamic> data) async {
    try {
      await ApiService.dio.patch('/driver/profile', data: data);
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
}
