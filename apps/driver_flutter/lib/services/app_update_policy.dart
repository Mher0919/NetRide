enum UpdateUrgency { none, optional, required }

enum AppUpdateChoice { update, later }

enum AppUpdateLaunchResult {
  storeOpened,
  updateStarted,
  flexibleStarted,
  cancelled,
  missingStoreUrl,
  failed,
}

const Set<String> kAllowedAccentColors = {
  '#42573F',
  '#5B7760',
  '#3F5363',
  '#8A5A12',
  '#7A3E3E',
};

const String kDefaultUpdateTitle = 'Update required';
const String kDefaultUpdateMessage =
    'A required update is ready. Please update to the latest version to continue using NetRide.';
const String kDefaultUpdateButton = 'Update Now';

const Map<String, String> kAndroidPackages = {
  'rider': 'com.netride.rider.rider_flutter',
  'driver': 'com.netride.driver.driver_flutter',
};

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
    required this.popupTitle,
    required this.popupMessage,
    required this.buttonText,
    required this.supportingText,
    required this.announcementLabel,
    required this.accentColor,
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
  final String popupTitle;
  final String popupMessage;
  final String buttonText;
  final String? supportingText;
  final String? announcementLabel;
  final String? accentColor;
  final UpdateUrgency urgency;
  final bool enabled;

  bool get hasUpdate => urgency != UpdateUrgency.none;
  bool get isRequired => urgency == UpdateUrgency.required;
}

AppUpdatePolicy buildAppUpdatePolicy({
  required Map<String, dynamic> raw,
  required String currentVersion,
  required int? currentBuild,
  required String appId,
  required String platform,
}) {
  final enabled = raw['enabled'] != false;
  final latestVersion = _stringValue(raw['latest_version']) ?? currentVersion;
  final minimumVersion =
      _stringValue(raw['minimum_version']) ?? currentVersion;
  final latestBuild = _intValue(raw['latest_build']);
  final minimumBuild = _intValue(raw['minimum_build']);

  final required = enabled &&
      (raw['update_required'] == true ||
          isBelowVersion(
            currentVersion,
            currentBuild,
            minimumVersion,
            minimumBuild,
          ));
  final available = enabled &&
      (required ||
          raw['update_available'] == true ||
          isBelowVersion(
            currentVersion,
            currentBuild,
            latestVersion,
            latestBuild,
          ));

  final accent = _stringValue(raw['accent_color']);
  final storeUrl = _stringValue(raw['store_url']) ?? '';

  return AppUpdatePolicy(
    currentVersion: currentVersion,
    currentBuild: currentBuild,
    latestVersion: latestVersion,
    minimumVersion: minimumVersion,
    latestBuild: latestBuild,
    minimumBuild: minimumBuild,
    storeUrl:
        isAllowedStoreUrl(storeUrl, appId: appId, platform: platform)
            ? storeUrl
            : '',
    releaseNotes: _stringValue(raw['release_notes']),
    popupTitle: _stringValue(raw['popup_title']) ?? kDefaultUpdateTitle,
    popupMessage:
        _stringValue(raw['popup_message']) ?? kDefaultUpdateMessage,
    buttonText: _stringValue(raw['button_text']) ?? kDefaultUpdateButton,
    supportingText: _stringValue(raw['supporting_text']),
    announcementLabel: _stringValue(raw['announcement_label']),
    accentColor:
        accent != null && kAllowedAccentColors.contains(accent) ? accent : null,
    urgency: required
        ? UpdateUrgency.required
        : available
            ? UpdateUrgency.optional
            : UpdateUrgency.none,
    enabled: enabled,
  );
}

int compareAppVersions(String left, String right) {
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

bool isBelowVersion(
  String currentVersion,
  int? currentBuild,
  String targetVersion,
  int? targetBuild,
) {
  if (_parseVersion(currentVersion) == null ||
      _parseVersion(targetVersion) == null) {
    return false;
  }
  final comparison = compareAppVersions(currentVersion, targetVersion);
  if (comparison != 0) return comparison < 0;
  if (currentBuild == null || targetBuild == null) return false;
  return currentBuild < targetBuild;
}

bool isAllowedStoreUrl(
  String value, {
  required String appId,
  required String platform,
}) {
  final uri = Uri.tryParse(value.trim());
  if (uri == null ||
      uri.scheme != 'https' ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasPort) {
    return false;
  }
  final host = uri.host.toLowerCase();

  if (platform == 'android') {
    final expectedPackage = kAndroidPackages[appId];
    return expectedPackage != null &&
        host == 'play.google.com' &&
        uri.path == '/store/apps/details' &&
        uri.queryParameters['id'] == expectedPackage;
  }

  return (host == 'apps.apple.com' || host == 'itunes.apple.com') &&
      RegExp(r'^/(?:[a-z]{2}/)?app/', caseSensitive: false)
          .hasMatch(uri.path);
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
