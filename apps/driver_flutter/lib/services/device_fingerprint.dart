import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

/// Stable, per-install device identifier persisted in SharedPreferences.
///
/// The backend uses this to detect new-device sign-ins and force a fresh
/// face verification when the driver logs in on hardware we have not seen
/// before (or have not seen in a long time).
class DeviceFingerprint {
  static const _prefsKey = 'device_id';

  /// Returns the cached device id, creating + persisting one on first call.
  static Future<String> getOrCreate() async {
    final prefs = await SharedPreferences.getInstance();
    final existing = prefs.getString(_prefsKey);
    if (existing != null && existing.isNotEmpty) return existing;

    final fresh = const Uuid().v4();
    await prefs.setString(_prefsKey, fresh);
    return fresh;
  }

  /// Returns the cached id without creating one (returns null if not set).
  static Future<String?> current() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_prefsKey);
  }
}