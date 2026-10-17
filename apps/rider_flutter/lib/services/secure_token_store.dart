import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Platform-backed secure storage for session credentials.
///
/// * Android: EncryptedSharedPreferences backed by the Android Keystore.
/// * iOS: Keychain.
///
/// Tokens, user ids and roles are NEVER written to ordinary
/// SharedPreferences. A synchronous in-memory mirror is hydrated once at
/// startup ([init]) so existing synchronous call sites keep working; writes
/// ([save]/[clear]) update the mirror and the encrypted store together.
///
/// The first [init] after an upgrade also migrates any legacy plaintext
/// values out of SharedPreferences and deletes them there, so existing
/// installations are not logged out and no plaintext copy survives.
class SecureTokenStore {
  static const _storage = FlutterSecureStorage();

  static const _tokenKey = 'jwt_token';
  static const _userIdKey = 'user_id';
  static const _userRoleKey = 'user_role';

  static String? _token;
  static String? _userId;
  static String? _userRole;

  static String? get token => _token;
  static String? get userId => _userId;
  static String? get userRole => _userRole;
  static bool get hasToken => _token != null;

  /// Hydrates the in-memory mirror and migrates legacy plaintext values.
  static Future<void> init() async {
    try {
      _token = await _storage.read(key: _tokenKey);
      _userId = await _storage.read(key: _userIdKey);
      _userRole = await _storage.read(key: _userRoleKey);
    } catch (e) {
      debugPrint('[SECURE STORE] read failed: $e');
    }

    try {
      final prefs = await SharedPreferences.getInstance();
      final legacyToken = prefs.getString(_tokenKey);
      final legacyUserId = prefs.getString(_userIdKey);
      final legacyRole = prefs.getString(_userRoleKey);

      if (_token == null && legacyToken != null) {
        _token = legacyToken;
        await _storage.write(key: _tokenKey, value: legacyToken);
      }
      if (_userId == null && legacyUserId != null) {
        _userId = legacyUserId;
        await _storage.write(key: _userIdKey, value: legacyUserId);
      }
      if (_userRole == null && legacyRole != null) {
        _userRole = legacyRole;
        await _storage.write(key: _userRoleKey, value: legacyRole);
      }

      // Purge the plaintext copies regardless of migration outcome.
      await prefs.remove(_tokenKey);
      await prefs.remove(_userIdKey);
      await prefs.remove(_userRoleKey);
    } catch (e) {
      debugPrint('[SECURE STORE] legacy migration failed: $e');
    }
  }

  /// Persists the session credentials and updates the in-memory mirror.
  static Future<void> save({
    required String token,
    required String userId,
    required String userRole,
  }) async {
    _token = token;
    _userId = userId;
    _userRole = userRole;
    try {
      await _storage.write(key: _tokenKey, value: token);
      await _storage.write(key: _userIdKey, value: userId);
      await _storage.write(key: _userRoleKey, value: userRole);
    } catch (e) {
      debugPrint('[SECURE STORE] write failed: $e');
      rethrow;
    }
  }

  /// Removes every stored credential (logout).
  static Future<void> clear() async {
    _token = null;
    _userId = null;
    _userRole = null;
    try {
      await _storage.delete(key: _tokenKey);
      await _storage.delete(key: _userIdKey);
      await _storage.delete(key: _userRoleKey);
    } catch (e) {
      debugPrint('[SECURE STORE] delete failed: $e');
    }
    // Defensive: never leave a plaintext copy behind.
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_tokenKey);
      await prefs.remove(_userIdKey);
      await prefs.remove(_userRoleKey);
    } catch (_) {}
  }
}
