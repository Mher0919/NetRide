// lib/services/notification_service.dart
import 'secure_token_store.dart';
//
// Real phone push notifications for the driver app.
//
// Delivery model (mirrors the rider app and the backend `sendPushAll`):
//   - FCM display messages are rendered by the system when the app is in
//     the background/terminated. In the FOREGROUND they are delivered to
//     `onMessage` and are NOT shown automatically — this service re-posts
//     them as local notifications so an offer is never invisible.
//   - Ride offers additionally get Accept/Decline actions (local
//     notification) that call the authenticated REST endpoints in a
//     background isolate. The notification payload is never trusted as
//     state: the server re-validates the offer, its expiry and ownership.
//   - Taps are routed via `data.route`; taps for offers always
//     re-validate against the server by asking for the current trip.
//   - Platform limitation: a notification rendered directly by FCM while
//     the process is dead cannot carry action buttons (Android system
//     notifications have no custom actions). In that case tapping opens
//     the app, which reconnects and asks the server for the authoritative
//     active trip / current offer.

import 'dart:convert';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api_service.dart';

/// Top-level FCM background handler (background isolate). Display messages
/// are handled by the system; data-only messages can be processed here.
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  try {
    await Firebase.initializeApp();
  } catch (_) {
    // Firebase not configured in this build/isolate — nothing to do.
  }
}

/// Top-level local-notification action handler (background isolate). Runs
/// the accept/decline call directly against the REST API using the token
/// from SharedPreferences; the app reconciles when it next resumes.
@pragma('vm:entry-point')
void notificationTapBackground(NotificationResponse response) {
  runOfferActionFromNotification(response.actionId, response.payload);
}

const _kApiBaseKey = 'push_api_base_url';

/// Performs an offer action from a notification without a live UI. Uses a
/// plain HttpClient so it does not depend on app-initialised singletons.
Future<void> runOfferActionFromNotification(
  String? actionId,
  String? payload,
) async {
  if (actionId != 'accept' && actionId != 'decline') return;
  if (payload == null || payload.isEmpty) return;

  String? token;
  String? baseUrl;
  try {
    final prefs = await SharedPreferences.getInstance();
    token = SecureTokenStore.token;
    baseUrl = prefs.getString(_kApiBaseKey) ?? 'https://netride.onride.com/api/';
  } catch (_) {
    return;
  }
  if (token == null || token.isEmpty) return;

  Map<String, dynamic> body;
  try {
    body = Map<String, dynamic>.from(jsonDecode(payload) as Map);
  } catch (_) {
    return;
  }
  final tripId = body['tripId']?.toString();
  final offerId = body['offerId']?.toString();
  if (tripId == null) return;

  final path = actionId == 'accept' ? 'ride/accept' : 'ride/decline';
  final uri = Uri.parse('$baseUrl$path');
  final client = HttpClient();
  try {
    final request = await client.postUrl(uri);
    request.headers.set('Content-Type', 'application/json');
    request.headers.set('Authorization', 'Bearer $token');
    final encoded = jsonEncode({
      'tripId': tripId,
      if (offerId != null && offerId.isNotEmpty) 'offerId': offerId,
    });
    request.write(encoded);
    final response = await request.close().timeout(const Duration(seconds: 15));
    await response.drain<void>();
    // The result is authoritative on the SERVER; the notification is
    // removed/collapsed by the OS action config. The app re-reconciles via
    // getCurrentTrip on next connect, so no local state is written here.
  } catch (_) {
    // Network failure: the offer remains governed by its server expiry.
    // The app will reconcile when it resumes; never assume success.
  } finally {
    client.close(force: true);
  }
}

class NotificationService {
  NotificationService._();
  static final NotificationService instance = NotificationService._();

  final FlutterLocalNotificationsPlugin _local = FlutterLocalNotificationsPlugin();
  FirebaseMessaging? _messaging;
  String? _currentToken;
  bool _localInitialized = false;

  /// Invoked when the user taps a push. The app decides where to go from
  /// the payload's `route` + `type`.
  void Function(Map<String, String> data)? onNotificationTap;

  /// Set by the app: returns true when a ride offer is already visible in
  /// the UI (so a foreground push must not double-alert).
  bool Function()? offerVisible;

  bool get isFirebaseAvailable => _messaging != null;

  /// Call once during startup. Never throws — Firebase is optional in local
  /// dev (no google-services.json) and the app must boot regardless.
  Future<void> init({
    required void Function(Map<String, String> data) onTap,
  }) async {
    onNotificationTap = onTap;

    // Persist the API base for background-isolate action handlers.
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_kApiBaseKey, ApiService.baseUrl);
    } catch (_) {}

    await _initLocalNotifications();

    // Channels the backend may name in pushes. Every channel referenced by
    // the backend must exist or Android silently downgrades/drops the
    // notification. `ride_offer` is the actionable high-importance channel.
    const channels = <String, (String, bool)>{
      'ride': ('Ride updates', true),
      'ride_offer': ('Ride offers', true),
      'chat': ('Messages', true),
      'call': ('Calls', true),
      'credits': ('Credits & rewards', false),
      'wallet': ('Wallet', false),
      'promo': ('Promotions', false),
      'referral': ('Referrals', false),
      'special': ('Specials & rewards', true),
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

    try {
      await Firebase.initializeApp();
      _messaging = FirebaseMessaging.instance;
      FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);
    } catch (e) {
      debugPrint('[NOTIF] Firebase unavailable (no google-services.json?): $e');
      return;
    }

    // iOS must be asked explicitly or no prompt ever appears and FCM
    // token delivery stays silent.
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS) {
      final settings = await _messaging!.requestPermission(
        alert: true,
        badge: true,
        sound: true,
      );
      debugPrint('[NOTIF] iOS permission: ${settings.authorizationStatus}');
    }

    _messaging!.getInitialMessage().then((message) {
      if (message != null) _handleTap(message);
    });
    FirebaseMessaging.onMessageOpenedApp.listen(_handleTap);

    // Foreground delivery: FCM does NOT render notification-block messages
    // while the app is open. Re-post them locally.
    FirebaseMessaging.onMessage.listen(_handleForegroundMessage);

    _messaging!.getToken().then((token) {
      if (token != null) registerDevice(token);
    });
    _messaging!.onTokenRefresh.listen((token) => registerDevice(token));
  }

  Future<void> _initLocalNotifications() async {
    if (_localInitialized) return;
    const settings = InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      iOS: DarwinInitializationSettings(
        requestAlertPermission: false,
        requestBadgePermission: false,
        requestSoundPermission: false,
      ),
    );
    try {
      await _local.initialize(
        settings: settings,
        onDidReceiveNotificationResponse: _onLocalNotificationResponse,
        onDidReceiveBackgroundNotificationResponse: notificationTapBackground,
      );
      _localInitialized = true;
    } catch (e) {
      debugPrint('[NOTIF] Local notifications init failed: $e');
    }
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
        'platform': !kIsWeb && defaultTargetPlatform == TargetPlatform.iOS
            ? 'ios'
            : 'android',
      });
      debugPrint('[NOTIF] FCM token registered for this device');
    } catch (e) {
      debugPrint('[NOTIF] Token registration failed (non-fatal): $e');
    }
  }

  Future<void> clearDevice() async {
    // Always attempt unregistration: after a cold start `_currentToken` is
    // null but FCM can still return the device token, which is what the
    // backend registry holds.
    final token = _currentToken ?? await _currentFcmToken();
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
  // Foreground + offer notification
  // ---------------------------------------------------------------------

  Future<void> _handleForegroundMessage(RemoteMessage message) async {
    final data = message.data;
    if (data.isEmpty) return;
    if (data['type'] == 'ride_offer') {
      // If the in-app offer card is already visible, the socket path has
      // precedence — do not double-alert.
      if (offerVisible?.call() == true) return;
      await showRideOfferNotification(data);
    }
  }

  /// Re-posts a ride offer as an actionable local notification. Exposed for
  /// the socket path too: a socket `newTripRequest` received while the app
  /// is backgrounded cannot render UI, so the provider calls this.
  Future<void> showRideOfferNotification(Map<String, dynamic> data) async {
    if (!_localInitialized) await _initLocalNotifications();
    final tripId = data['tripId']?.toString() ?? data['id']?.toString();
    final offerId = data['offerId']?.toString() ?? data['offer_id']?.toString();
    if (tripId == null) return;

    final earnings = int.tryParse(data['earningsCents']?.toString() ?? '');
    final pickupAddress = data['pickupAddress']?.toString();
    final body = earnings != null
        ? 'Estimated earnings \$${(earnings / 100).toStringAsFixed(2)}'
        : (pickupAddress != null && pickupAddress.isNotEmpty
            ? 'Pickup near $pickupAddress'
            : 'Tap to view the request');

    // Android auto-dismisses after the server-defined expiry; the offer is
    // never actionable past its deadline.
    int? timeoutAfter;
    final expiresAt = DateTime.tryParse(data['expiresAt']?.toString() ?? '');
    if (expiresAt != null) {
      final ms = expiresAt.difference(DateTime.now()).inMilliseconds;
      timeoutAfter = ms.clamp(5000, 60000);
    }

    final payload = jsonEncode({
      'type': 'ride_offer',
      'tripId': tripId,
      if (offerId != null && offerId.isNotEmpty) 'offerId': offerId,
    });

    final details = NotificationDetails(
      android: AndroidNotificationDetails(
        'ride_offer',
        'Ride offers',
        channelDescription: 'Incoming ride requests',
        importance: Importance.max,
        priority: Priority.high,
        category: AndroidNotificationCategory.event,
        timeoutAfter: timeoutAfter,
        actions: const <AndroidNotificationAction>[
          AndroidNotificationAction(
            'accept',
            'Accept',
            showsUserInterface: false,
            cancelNotification: true,
          ),
          AndroidNotificationAction(
            'decline',
            'Decline',
            showsUserInterface: false,
            cancelNotification: true,
          ),
        ],
      ),
      iOS: const DarwinNotificationDetails(
        categoryIdentifier: 'ride_offer',
        interruptionLevel: InterruptionLevel.timeSensitive,
      ),
    );

    try {
      await _local.show(
        id: offerId?.hashCode ?? tripId.hashCode,
        title: 'New ride request',
        body: body,
        notificationDetails: details,
        payload: payload,
      );
    } catch (e) {
      debugPrint('[NOTIF] Failed to show offer notification: $e');
    }
  }

  /// Cancels a still-visible offer notification (offer expired/withdrawn/
  /// accepted by another driver).
  Future<void> cancelOfferNotification(String offerId) async {
    try {
      await _local.cancel(id: offerId.hashCode);
    } catch (_) {}
  }

  // ---------------------------------------------------------------------
  // Tap handling
  // ---------------------------------------------------------------------

  void _onLocalNotificationResponse(NotificationResponse response) {
    // Action buttons (accept/decline) act through REST. A body tap opens
    // the app; the provider reconciles the authoritative trip.
    if (response.actionId == 'accept' || response.actionId == 'decline') {
      runOfferActionFromNotification(response.actionId, response.payload);
      return;
    }
    if (response.payload != null && response.payload!.isNotEmpty) {
      try {
        final data = Map<String, dynamic>.from(jsonDecode(response.payload!) as Map);
        final flat = data.map((k, v) => MapEntry(k, v is String ? v : '$v'));
        onNotificationTap?.call(flat);
      } catch (_) {}
    }
  }

  void _handleTap(RemoteMessage message) {
    final data = message.data;
    if (data.isEmpty) return;
    final flat = data.map((k, v) => MapEntry(k, v is String ? v : '$v'));
    debugPrint('[NOTIF] Tap on ${flat['type']} → ${flat['route']}');
    onNotificationTap?.call(flat);
  }
}