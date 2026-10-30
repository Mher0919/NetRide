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

  static const String _appId = 'rider';
  static const String _cacheKey = 'app_version_policy_rider';
  static const String _cacheAtKey = 'app_version_policy_rider_at';
  static const Duration _cacheMaxAge = Duration(hours: 24);
  static const Duration _requestTimeout = Duration(seconds: 6);

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

  Future<AppUpdateLaunchResult> openStore(AppUpdatePolicy policy) async {
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
      try {
        final info = await InAppUpdate.checkForUpdate();
        final hasPlayUpdate =
            info.updateAvailability == UpdateAvailability.updateAvailable ||
            info.updateAvailability ==
                UpdateAvailability.developerTriggeredUpdateInProgress;

        if (hasPlayUpdate && info.immediateUpdateAllowed) {
          final result = await InAppUpdate.performImmediateUpdate();
          if (result == AppUpdateResult.success) {
            return AppUpdateLaunchResult.updateStarted;
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
