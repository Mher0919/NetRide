// lib/services/notification_service.dart
//
// Real phone push notifications for the driver app.
//
// Delivery model (mirrors the rider app and the backend `sendPushAll`):
//   - FCM messages carry a `notification` block + `data` block; Android
//     renders the system notification itself (foreground included), so this
//     service never re-renders a message that already carries one.
//   - Taps are routed via `data.route` — the driver currently receives
//     ride-cancelled pushes only, which land on the availability dashboard.
//   - The FCM token is registered per-device (POST /api/push/register-token)
//     and unregistered on logout (DELETE /api/push/token) so a shared phone
//     stops receiving pushes for the previous driver.

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'api_service.dart';

class NotificationService {
  NotificationService._();
  static final NotificationService instance = NotificationService._();

  final FlutterLocalNotificationsPlugin _local = FlutterLocalNotificationsPlugin();
  FirebaseMessaging? _messaging;
  String? _currentToken;

  /// Invoked when the user taps a push. The app decides where to go from
  /// the payload's `route` + `type`.
  void Function(Map<String, String> data)? onNotificationTap;

  bool get isFirebaseAvailable => _messaging != null;

  /// Call once during startup. Never throws — Firebase is optional in local
  /// dev (no google-services.json) and the app must boot regardless.
  Future<void> init({
    required void Function(Map<String, String> data) onTap,
  }) async {
    onNotificationTap = onTap;

    try {
      await Firebase.initializeApp();
      _messaging = FirebaseMessaging.instance;
    } catch (e) {
      debugPrint('[NOTIF] Firebase unavailable (no google-services.json?): $e');
      return;
    }

    // Channels the backend may name in pushes. Ride updates are loud;
    // everything else uses the default silent channel.
    const channels = <String, (String, bool)>{
      'ride': ('Ride updates', true),
      'default': ('NetRide', false),
    };
    for (final entry in channels.entries) {
      await _local
          .resolvePlatformSpecificImplementation<
              AndroidFlutterLocalNotificationsPlugin>()
          ?.createNotificationChannel(AndroidNotificationChannel(
        entry.key,
        entry.value.$1,
        description: 'NetRide notifications',
        importance: entry.value.$2
            ? Importance.high
            : Importance.defaultImportance,
        playSound: true,
      ));
    }

    await _local
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>()
        ?.requestNotificationsPermission();

    _messaging!.getInitialMessage().then((message) {
      if (message != null) _handleTap(message);
    });
    FirebaseMessaging.onMessageOpenedApp.listen(_handleTap);

    _messaging!.getToken().then((token) {
      if (token != null) registerDevice(token);
    });
    _messaging!.onTokenRefresh.listen((token) => registerDevice(token));
  }

  // ---------------------------------------------------------------------
  // Token registry (per-device)
  // ---------------------------------------------------------------------

  Future<void> registerDevice([String? token]) async {
    final effective = token ?? await _currentFcmToken();
    if (effective == null || effective.isEmpty) return;
    _currentToken = effective;
    try {
      await ApiService.dio.post('/push/register-token', data: {
        'token': effective,
        'platform': 'android',
      });
      debugPrint('[NOTIF] FCM token registered for this device');
    } catch (e) {
      debugPrint('[NOTIF] Token registration failed (non-fatal): $e');
    }
  }

  Future<void> clearDevice() async {
    final token = _currentToken;
    if (token == null || token.isEmpty) return;
    try {
      await ApiService.dio.delete('/push/token', data: {'token': token});
      debugPrint('[NOTIF] FCM token unregistered for this device');
    } catch (e) {
      debugPrint('[NOTIF] Token unregistration failed (non-fatal): $e');
    } finally {
      _currentToken = null;
    }
  }

  Future<String?> _currentFcmToken() async {
    try {
      return await _messaging?.getToken();
    } catch (e) {
      debugPrint('[NOTIF] getToken failed: $e');
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // Tap handling
  // ---------------------------------------------------------------------

  void _handleTap(RemoteMessage message) {
    final data = message.data;
    if (data.isEmpty) return;
    final flat = data.map((k, v) => MapEntry(k, v is String ? v : '$v'));
    debugPrint('[NOTIF] Tap on ${flat['type']} → ${flat['route']}');
    onNotificationTap?.call(flat);
  }
}