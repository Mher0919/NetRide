import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:in_app_update/in_app_update.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import 'api_service.dart';
import 'app_update_policy.dart';

export 'app_update_policy.dart';

class AppVersionService {
  AppVersionService._();

  static final AppVersionService instance = AppVersionService._();

  static const String _appId = 'driver';
  static const String _cacheKey = 'app_version_policy_driver';
  static const String _cacheAtKey = 'app_version_policy_driver_at';
  static const String _optionalSkipKey = 'app_version_optional_skipped_driver';
  static const String _optionalSkipAtKey = 'app_version_optional_skipped_driver_at';
  static const Duration _cacheMaxAge = Duration(hours: 24);
  static const Duration _optionalPromptWindow = Duration(hours: 24);
  static const Duration _requestTimeout = Duration(seconds: 6);

  StreamSubscription<InstallStatus>? _flexibleUpdateSubscription;

  Future<AppUpdatePolicy?> check({
    Duration timeout = _requestTimeout,
  }) async {
    final packageInfo = await PackageInfo.fromPlatform();
    final currentVersion = packageInfo.version;
    final currentBuild = int.tryParse(packageInfo.buildNumber);

    Map<String, dynamic>? raw;
    final cancelToken = CancelToken();
    final timer = Timer(timeout, () {
      cancelToken.cancel('version-check-timeout');
    });

    try {
      final response = await ApiService.dio.get<dynamic>(
        'app/version',
        queryParameters: {
          'app': _appId,
          'platform': _platformName,
          'currentVersion': currentVersion,
          'buildNumber': ?currentBuild,
        },
        cancelToken: cancelToken,
        options: Options(
          receiveTimeout: timeout,
          sendTimeout: timeout,
        ),
      );
      if (response.data is Map) {
        raw = Map<String, dynamic>.from(response.data as Map);
        await _cache(raw);
      }
    } catch (error) {
      debugPrint('[APP-UPDATE] Version check failed: $error');
    } finally {
      timer.cancel();
    }

    raw ??= await _readCache();
    if (raw == null) return null;

    return buildAppUpdatePolicy(
      raw: raw,
      currentVersion: currentVersion,
      currentBuild: currentBuild,
      appId: _appId,
      platform: _platformName,
    );
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

    final storeUrl = policy.storeUrl;
    if (!isAllowedStoreUrl(
      storeUrl,
      appId: _appId,
      platform: _platformName,
    )) {
      return AppUpdateLaunchResult.missingStoreUrl;
    }

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
    } catch (error) {
      debugPrint('[APP-UPDATE] Ignoring invalid cached policy: $error');
    }
    return null;
  }
}
