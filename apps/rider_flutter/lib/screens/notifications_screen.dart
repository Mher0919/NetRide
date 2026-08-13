// lib/screens/notifications_screen.dart
//
// In-app notification history — the backend `notifications` table is the
// single source of truth (survives app restarts and offline pushes). The
// list refreshes live via the socket `notificationReceived` ping while the
// app is open. Tapping an item opens the surface for its type.

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../providers/ride_provider.dart';
import '../services/api_service.dart';
import 'credits_screen.dart';
import 'trip_screen.dart';

class AppNotification {
  final String id;
  final String type;
  final String title;
  final String body;
  final DateTime createdAt;
  final DateTime? readAt;
  final Map<String, dynamic> data;
  final String route;

  const AppNotification({
    required this.id,
    required this.type,
    required this.title,
    required this.body,
    required this.createdAt,
    this.readAt,
    this.data = const {},
    this.route = '/',
  });

  bool get isRead => readAt != null;

  factory AppNotification.fromJson(Map<String, dynamic> json) {
    final dataRaw = json['data'];
    final data = dataRaw is Map<String, dynamic>
        ? dataRaw
        : <String, dynamic>{};
    return AppNotification(
      id: json['id'] as String,
      type: (json['type'] as String?) ?? 'generic',
      title: (json['title'] as String?) ?? 'NetRide',
      body: (json['body'] as String?) ?? '',
      createdAt: DateTime.tryParse((json['created_at'] as String?) ?? '') ??
          DateTime.now(),
      readAt: json['read_at'] != null
          ? DateTime.tryParse(json['read_at'] as String)
          : null,
      data: data,
      route: (data['route'] as String?) ?? '/',
    );
  }
}

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  List<AppNotification>? _items;
  int? _unread;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
    // Live refresh: the backend emits `notificationReceived` on the socket
    // whenever a new notification is recorded for this rider.
    Provider.of<RideProvider>(context, listen: false)
        .notificationPing
        .listen((_) => _load(silent: true));
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent) setState(() => _loading = true);
    try {
      final results = await Future.wait([
        ApiService.dio.get('notifications', queryParameters: {'limit': 50}),
        ApiService.dio.get('notifications/unread-count'),
      ]);
      final items = ((results[0].data as Map<String, dynamic>)['notifications']
              as List? ??
          [])
          .map((e) => AppNotification.fromJson(e as Map<String, dynamic>))
          .toList();
      final unread = ((results[1].data as Map<String, dynamic>)['count'] as num?)?.toInt() ?? 0;
      if (!mounted) return;
      setState(() {
        _items = items;
        _unread = unread;
        _error = null;
        _loading = false;
      });
    } on DioException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.response?.statusCode == 401
            ? 'Please sign in again.'
            : 'Could not load notifications. Pull to retry.';
        _loading = false;
      });
    }
  }

  Future<void> _markRead(AppNotification notification) async {
    if (notification.isRead) return;
    try {
      await ApiService.dio.post('notifications/read', data: {'id': notification.id});
      setState(() {
        final idx = _items?.indexWhere((n) => n.id == notification.id);
        if (idx != null && idx >= 0) {
          final updated = _items![idx];
          _items![idx] = AppNotification(
            id: updated.id,
            type: updated.type,
            title: updated.title,
            body: updated.body,
            createdAt: updated.createdAt,
            readAt: DateTime.now(),
            data: updated.data,
            route: updated.route,
          );
        }
        _unread = (_unread ?? 0) > 0 ? (_unread! - 1) : 0;
      });
    } catch (e) {
      debugPrint('[NOTIF] mark-read failed: $e');
    }
  }

  Future<void> _markAllRead() async {
    final unreadIds = (_items ?? [])
        .where((n) => !n.isRead)
        .map((n) => n.id)
        .toList();
    if (unreadIds.isEmpty) return;
    try {
      await ApiService.dio.post('notifications/read', data: {'ids': unreadIds});
      setState(() {
        _items = (_items ?? []).map((n) {
          if (!n.isRead) {
            return AppNotification(
              id: n.id,
              type: n.type,
              title: n.title,
              body: n.body,
              createdAt: n.createdAt,
              readAt: DateTime.now(),
              data: n.data,
              route: n.route,
            );
          }
          return n;
        }).toList();
        _unread = 0;
      });
    } catch (e) {
      debugPrint('[NOTIF] mark-all-read failed: $e');
    }
  }

  void _open(AppNotification notification) {
    _markRead(notification);
    switch (notification.route) {
      case '/trip':
        Navigator.push(context, MaterialPageRoute(builder: (_) => const TripScreen()));
        break;
      case '/credits':
        Navigator.push(context, MaterialPageRoute(builder: (_) => const CreditsScreen()));
        break;
      default:
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded),
          onPressed: () => Navigator.pop(context),
        ),
        title: Text('Notifications', style: theme.textTheme.headlineMedium?.copyWith(fontSize: 22)),
        actions: [
          if (_unread != null && _unread! > 0)
            TextButton(
              onPressed: _markAllRead,
              child: const Text('Mark all read'),
            ),
        ],
      ),
      body: _buildBody(theme),
    );
  }

  Widget _buildBody(ThemeData theme) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null && (_items == null || _items!.isEmpty)) {
      return RefreshIndicator(
        onRefresh: () => _load(),
        child: ListView(
          children: [
            const SizedBox(height: 200),
            Icon(Icons.notifications_off_rounded, size: 56, color: theme.disabledColor),
            const SizedBox(height: 12),
            Center(
              child: Text(_error!,
                  style: theme.textTheme.bodyMedium?.copyWith(color: theme.disabledColor)),
            ),
          ],
        ),
      );
    }
    final items = _items ?? [];
    if (items.isEmpty) {
      return RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          children: [
            const SizedBox(height: 200),
            Icon(Icons.notifications_none_rounded, size: 56, color: theme.disabledColor),
            const SizedBox(height: 12),
            Center(
              child: Text('No notifications yet',
                  style: theme.textTheme.bodyMedium?.copyWith(color: theme.disabledColor)),
            ),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        itemCount: items.length,
        separatorBuilder: (_, __) => const SizedBox(height: 4),
        itemBuilder: (context, index) => _NotificationTile(
          notification: items[index],
          onTap: () => _open(items[index]),
        ),
      ),
    );
  }
}

class _NotificationTile extends StatelessWidget {
  const _NotificationTile({required this.notification, required this.onTap});

  final AppNotification notification;
  final VoidCallback onTap;

  static const _categoryMeta = <String, (IconData, Color)>{
    'ride_accepted': (Icons.taxi_alert_rounded, Color(0xFF2E7D32)),
    'driver_arrived': (Icons.location_on_rounded, Color(0xFF2E7D32)),
    'ride_started': (Icons.directions_car_filled_rounded, Color(0xFF2E7D32)),
    'ride_completed': (Icons.verified_rounded, Color(0xFF2E7D32)),
    'ride_cancelled': (Icons.cancel_rounded, Color(0xFFC65A5A)),
    'credits_earned': (Icons.savings_rounded, Color(0xFF1B6F9E)),
    'credits_applied': (Icons.receipt_long_rounded, Color(0xFF1B6F9E)),
    'wallet_charged': (Icons.account_balance_wallet_rounded, Color(0xFF1B6F9E)),
    'promo_applied': (Icons.local_offer_rounded, Color(0xFFB26A00)),
    'referral_linked': (Icons.group_add_rounded, Color(0xFF5B7760)),
    'referral_reward': (Icons.card_giftcard_rounded, Color(0xFF5B7760)),
  };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final meta = _categoryMeta[notification.type] ??
        (Icons.notifications_rounded, theme.colorScheme.primary);
    final time = DateFormat('MMM d, h:mm a').format(notification.createdAt.toLocal());
    return Material(
      color: notification.isRead ? Colors.white : const Color(0xFFF3F7F2),
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: meta.$2.withOpacity(0.12),
                  shape: BoxShape.circle,
                ),
                child: Icon(meta.$1, size: 22, color: meta.$2),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            notification.title,
                            style: theme.textTheme.bodyMedium?.copyWith(
                              fontWeight: notification.isRead
                                  ? FontWeight.w500
                                  : FontWeight.w700,
                            ),
                          ),
                        ),
                        if (!notification.isRead)
                          Container(
                            width: 8,
                            height: 8,
                            decoration: const BoxDecoration(
                              color: Color(0xFF2E7D32),
                              shape: BoxShape.circle,
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(notification.body,
                        style: theme.textTheme.bodySmall
                            ?.copyWith(color: theme.disabledColor)),
                    const SizedBox(height: 4),
                    Text(time,
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: theme.colorScheme.primary.withOpacity(0.7),
                        )),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}