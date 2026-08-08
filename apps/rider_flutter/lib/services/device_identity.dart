// lib/services/device_identity.dart
//
// Privacy-conscious install identifier used ONLY as a fraud signal for
// referral reward eligibility (backend decides; the device is never the
// sole authority). An opaque UUID generated once per install and persisted
// locally — NOT a hardware identifier, so no device tracking is involved.

import 'package:shared_preferences/shared_preferences.dart';
import 'dart:math';

class DeviceIdentity {
  static const _key = 'netride_install_id';
  static String? _cached;

  static Future<String> installId() async {
    if (_cached != null) return _cached!;
    final prefs = await SharedPreferences.getInstance();
    var id = prefs.getString(_key);
    if (id == null || id.isEmpty) {
      final rand = Random.secure();
      id = List.generate(32, (_) => rand.nextInt(16).toRadixString(16)).join();
      await prefs.setString(_key, id);
    }
    _cached = id;
    return id;
  }
}
