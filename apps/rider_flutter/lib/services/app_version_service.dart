import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:in_app_update/in_app_update.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import 'api_service.dart';

enum UpdateUrgency { none, optional, required }

enum AppUpdateChoice { update, later }

enum AppUpdateLaunchResult {
  storeOpened,
  updateStarted,
  flexibleStarted,
  cancelled,
  failed,
}

class AppUpdatePolicy {
  const AppUpdatePolicy({
    required this.currentVersion,
    required this.currentBuild,
    required this.latestVersion,
    required this.minimumVersion,
    required this.latestBuild,
    required this.minimumBuild,
    required this.storeUrl,
    required this.releaseNotes,
    required this.urgency,
    required this.enabled,
  });

  final String currentVersion;
  final int? currentBuild;
  final String latestVersion;
  final String minimumVersion;
  final int? latestBuild;
  final int? minimumBuild;
  final String storeUrl;
  final String? releaseNotes;
  final UpdateUrgency urgency;
  final bool enabled;

  bool get hasUpdate => urgency != UpdateUrgency.none;
  bool get isRequired => urgency == UpdateUrgency.required;
}

class AppVersionService {
  AppVersionService._();

  static final AppVersionService instance = AppVersionService._();

  static const String _appId = 'rider';
  static const String _cacheKey = 'app_version_policy_rider';
  static const String _cacheAtKey = 'app_version_policy_rider_at';
  static const String _optionalSkipKey = 'app_version_optional_skipped_rider';
  static const String _optionalSkipAtKey = 'app_version_optional_skipped_rider_at';
  static const String _androidFallbackStoreUrl =
      'https://play.google.com/store/apps/details?id=com.netride.rider.rider_flutter';
  static const String _iosFallbackStoreUrl =
      'https://apps.apple.com/us/search?term=NetRide%20Rider';
  static const Duration _cacheMaxAge = Duration(hours: 24);
  static const Duration _optionalPromptWindow = Duration(hours: 24);

  StreamSubscription<InstallStatus>? _flexibleUpdateSubscription;

  Future<AppUpdatePolicy?> check() async {
    final packageInfo = await PackageInfo.fromPlatform();
    final currentVersion = packageInfo.version;
    final currentBuild = int.tryParse(packageInfo.buildNumber);

    Map<String, dynamic>? raw;
    try {
      final response = await ApiService.dio.get<dynamic>(
        'app/version',
        queryParameters: {
          'app': _appId,
          'platform': _platformName,
          'currentVersion': currentVersion,
          'buildNumber': ?currentBuild,
        },
      );
      if (response.data is Map) {
        raw = Map<String, dynamic>.from(response.data as Map);
        await _cache(raw);
      }
    } catch (error) {
      debugPrint('[APP-UPDATE] Version check failed: $error');
    }

    raw ??= await _readCache();
    if (raw == null) return null;

    return _policyFrom(raw, currentVersion, currentBuild);
  }

  Future<bool> shouldPromptOptional(AppUpdatePolicy policy) async {
    final prefs = await SharedPreferences.getInstance();
    final skippedVersion = prefs.getString(_optionalSkipKey);
    final skippedAt = prefs.getInt(_optionalSkipAtKey) ?? 0;
    if (skippedVersion != policy.latestVersion) return true;
    final age = DateTime.now().millisecondsSinceEpoch - skippedAt;
    return age >= _optionalPromptWindow.inMilliseconds;
  }

  Future<void> dismissOptional(AppUpdatePolicy policy) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_optionalSkipKey, policy.latestVersion);
    await prefs.setInt(
      _optionalSkipAtKey,
      DateTime.now().millisecondsSinceEpoch,
    );
  }

  Future<AppUpdateLaunchResult> openStore(
    AppUpdatePolicy policy, {
    required bool immediate,
  }) async {
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
      try {
        final info = await InAppUpdate.checkForUpdate();
        final hasPlayUpdate =
            info.updateAvailability == UpdateAvailability.updateAvailable ||
            info.updateAvailability ==
                UpdateAvailability.developerTriggeredUpdateInProgress;

        if (hasPlayUpdate && immediate && info.immediateUpdateAllowed) {
          final result = await InAppUpdate.performImmediateUpdate();
          if (result == AppUpdateResult.success) {
            return AppUpdateLaunchResult.updateStarted;
          }
          if (result == AppUpdateResult.userDeniedUpdate) {
            return AppUpdateLaunchResult.cancelled;
          }
        } else if (hasPlayUpdate &&
            !immediate &&
            info.flexibleUpdateAllowed) {
          final result = await InAppUpdate.startFlexibleUpdate();
          if (result == AppUpdateResult.success) {
            _watchFlexibleUpdate();
            return AppUpdateLaunchResult.flexibleStarted;
          }
          if (result == AppUpdateResult.userDeniedUpdate) {
            return AppUpdateLaunchResult.cancelled;
          }
        }
      } catch (error) {
        debugPrint('[APP-UPDATE] Play in-app update unavailable: $error');
      }
    }

    final storeUrl = policy.storeUrl.isNotEmpty
        ? policy.storeUrl
        : (defaultTargetPlatform == TargetPlatform.iOS
            ? _iosFallbackStoreUrl
            : _androidFallbackStoreUrl);

    try {
      final opened = await launchUrl(
        Uri.parse(storeUrl),
        mode: LaunchMode.externalApplication,
      );
      return opened
          ? AppUpdateLaunchResult.storeOpened
          : AppUpdateLaunchResult.failed;
    } catch (error) {
      debugPrint('[APP-UPDATE] Could not open store: $error');
      return AppUpdateLaunchResult.failed;
    }
  }

  Future<void> completePendingFlexibleUpdate() async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return;
    try {
      final info = await InAppUpdate.checkForUpdate();
      if (info.installStatus == InstallStatus.downloaded) {
        await InAppUpdate.completeFlexibleUpdate();
      }
    } catch (error) {
      debugPrint('[APP-UPDATE] Flexible update completion skipped: $error');
    }
  }

  void _watchFlexibleUpdate() {
    _flexibleUpdateSubscription ??=
        InAppUpdate.installUpdateListener.listen((status) async {
      if (status != InstallStatus.downloaded) return;
      try {
        await InAppUpdate.completeFlexibleUpdate();
      } catch (error) {
        debugPrint('[APP-UPDATE] Could not install downloaded update: $error');
      }
    });
  }

  String get _platformName {
    if (defaultTargetPlatform == TargetPlatform.iOS) return 'ios';
    return 'android';
  }

  AppUpdatePolicy _policyFrom(
    Map<String, dynamic> raw,
    String currentVersion,
    int? currentBuild,
  ) {
    final enabled = raw['enabled'] != false;
    final latestVersion =
        _stringValue(raw['latest_version']) ?? currentVersion;
    final minimumVersion =
        _stringValue(raw['minimum_version']) ?? currentVersion;
    final latestBuild = _intValue(raw['latest_build']);
    final minimumBuild = _intValue(raw['minimum_build']);

    final required = enabled &&
        (raw['update_required'] == true ||
            _isBelow(
              currentVersion,
              currentBuild,
              minimumVersion,
              minimumBuild,
            ));
    final available = enabled &&
        (required ||
            raw['update_available'] == true ||
            _isBelow(
              currentVersion,
              currentBuild,
              latestVersion,
              latestBuild,
            ));

    final urgency = required
        ? UpdateUrgency.required
        : available
            ? UpdateUrgency.optional
            : UpdateUrgency.none;

    return AppUpdatePolicy(
      currentVersion: currentVersion,
      currentBuild: currentBuild,
      latestVersion: latestVersion,
      minimumVersion: minimumVersion,
      latestBuild: latestBuild,
      minimumBuild: minimumBuild,
      storeUrl: _stringValue(raw['store_url']) ?? '',
      releaseNotes: _stringValue(raw['release_notes']),
      urgency: urgency,
      enabled: enabled,
    );
  }

  bool _isBelow(
    String currentVersion,
    int? currentBuild,
    String targetVersion,
    int? targetBuild,
  ) {
    final comparison = _compareVersions(currentVersion, targetVersion);
    if (comparison != 0) return comparison < 0;
    if (currentBuild == null || targetBuild == null) return false;
    return currentBuild < targetBuild;
  }

  int _compareVersions(String left, String right) {
    final a = _parseVersion(left);
    final b = _parseVersion(right);
    if (a == null || b == null) return 0;

    final length = a.length > b.length ? a.length : b.length;
    for (var i = 0; i < length; i++) {
      final av = i < a.length ? a[i] : 0;
      final bv = i < b.length ? b[i] : 0;
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  }

  List<int>? _parseVersion(String value) {
    final core = value.trim().split('+').first.split('-').first;
    if (!RegExp(r'^\d+(\.\d+){0,3}$').hasMatch(core)) return null;
    return core.split('.').map(int.parse).toList(growable: false);
  }

  String? _stringValue(dynamic value) {
    if (value is String && value.trim().isNotEmpty) return value.trim();
    return null;
  }

  int? _intValue(dynamic value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    if (value is String) return int.tryParse(value);
    return null;
  }

  Future<void> _cache(Map<String, dynamic> raw) async {
    final prefs = await SharedPreferences.getInstance();
    final cacheable = Map<String, dynamic>.from(raw)
      ..remove('update_required')
      ..remove('update_available');
    await prefs.setString(_cacheKey, jsonEncode(cacheable));
    await prefs.setInt(_cacheAtKey, DateTime.now().millisecondsSinceEpoch);
  }

  Future<Map<String, dynamic>?> _readCache() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_cacheKey);
    final cachedAt = prefs.getInt(_cacheAtKey);
    if (raw == null || cachedAt == null) return null;
    if (DateTime.now().millisecondsSinceEpoch - cachedAt >
        _cacheMaxAge.inMilliseconds) {
      return null;
    }
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
    } catch (_) {}
    return null;
  }
}
