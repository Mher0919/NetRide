// lib/services/notification_service.dart
//
// Real phone push notifications for the rider app.
//
// Delivery model (matches the backend `sendPushAll`):
//   - FCM messages carry BOTH a `notification` block and a `data` block.
//   - Foreground / background-with-process: Firebase shows the system
//     notification itself (Android handles display messages even while the
//     app is in the foreground), so this service does NOT re-render a local
//     notification for the same message — that would double the tray entry.
//   - The in-app notifications history is read from the backend REST API
//     (GET /api/notifications), which is the single source of truth and
//     survives pushes fired while the user is offline.
//   - Taps are routed to the app surface named in `data.route`
//     ('/trip' | '/credits' | '/').
//
// The FCM token is registered with the backend per-device
// (POST /api/push/register-token) so one user can receive pushes on several
// phones; it is unregistered on logout so a user signing out on a shared
// device stops receiving pushes there.

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'api_service.dart';

/// Payload carried on every NetRide push. Compiled by the backend
/// notification.service; the client only interprets it.
class NetRideNotification {
  final String type;
  final String? title;
  final String? body;
  final String route;
  final Map<String, String> data;

  const NetRideNotification({
    required this.type,
    this.title,
    this.body,
    this.route = '/',
    this.data = const {},
  });

  bool get isRideEvent =>
      type == 'ride_accepted' ||
      type == 'driver_arrived' ||
      type == 'ride_started' ||
      type == 'ride_completed';
}

class NotificationService {
  NotificationService._();
  static final NotificationService instance = NotificationService._();

  final FlutterLocalNotificationsPlugin _local = FlutterLocalNotificationsPlugin();
  FirebaseMessaging? _messaging;
  String? _currentToken;

  /// Invoked when the user taps a push. The app decides where to go from
  /// the payload's `route` + `type`.
  void Function(NetRideNotification notification)? onNotificationTap;

  bool get isFirebaseAvailable => _messaging != null;

  /// Call once during startup, after dotenv/ApiService are ready but before
  /// runApp. Never throws — Firebase is optional (no google-services.json in
  /// local dev) and the app must boot regardless.
  Future<void> init({
    required void Function(NetRideNotification notification) onTap,
  }) async {
    onNotificationTap = onTap;

    try {
      await Firebase.initializeApp();
      _messaging = FirebaseMessaging.instance;
    } catch (e) {
      debugPrint('[NOTIF] Firebase unavailable (no google-services.json?): $e');
      return;
    }

    // Channels must exist before any notification is shown. The backend
    // names channels: ride, credits, wallet, promo, referral, default.
    // Importance is per-channel so ride events can be loud while money
    // events stay quiet.
    const channels = <String, (String, bool)>{
      'ride': ('Ride updates', true),
      'credits': ('Ride credits', false),
      'wallet': ('Wallet', false),
      'promo': ('Promotions', false),
      'referral': ('Referrals', false),
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

    // Android 13+ runtime permission. iOS permission is out of scope (the
    // rider app targets Android; NetRide's iOS builds use in-app audio + UI).
    await _local
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>()
        ?.requestNotificationsPermission();

    // Foreground taps + launches-from-killed state both arrive here.
    _messaging!.getInitialMessage().then((message) {
      if (message != null) _handleTap(message);
    });
    FirebaseMessaging.onMessageOpenedApp.listen(_handleTap);

    // Register the (possibly refreshed) token with the backend.
    _messaging!.getToken().then((token) {
      if (token != null) registerDevice(token);
    });
    _messaging!.onTokenRefresh.listen((token) => registerDevice(token));
  }

  // ---------------------------------------------------------------------
  // Token registry (per-device)
  // ---------------------------------------------------------------------

  /// POST /api/push/register-token — server stores one row per device and
  /// dedupes by token, so multi-device logins all receive pushes.
  Future<void> registerDevice([String? token]) async {
    final effective = token ?? await _currentFcmToken();
    if (effective == null || effective.isEmpty) return;
    _currentToken = effective;
    try {
      await ApiService.dio.post('push/register-token', data: {
        'token': effective,
        'platform': 'android',
      });
      debugPrint('[NOTIF] FCM token registered for this device');
    } catch (e) {
      debugPrint('[NOTIF] Token registration failed (non-fatal): $e');
    }
  }

  /// DELETE /api/push/token (with this device's token) — used on logout so
  /// the backend stops pushing to a device that is no longer signed in.
  Future<void> clearDevice() async {
    final token = _currentToken;
    if (token == null || token.isEmpty) return;
    try {
      await ApiService.dio.delete('push/token', data: {'token': token});
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
    final nav = _parse(data, message.notification?.title, message.notification?.body);
    if (nav == null) return;
    debugPrint('[NOTIF] Tap on ${nav.type} → ${nav.route}');
    onNotificationTap?.call(nav);
  }

  static NetRideNotification? _parse(
    Map<String, dynamic> data, [
    String? title,
    String? body,
  ]) {
    final type = data['type'] as String?;
    if (type == null || type.isEmpty) return null;
    return NetRideNotification(
      type: type,
      title: title ?? data['title'] as String?,
      body: body ?? data['body'] as String?,
      route: (data['route'] as String?) ?? '/',
      data: data.map((k, v) => MapEntry(k, v is String ? v : '$v')),
    );
  }
}