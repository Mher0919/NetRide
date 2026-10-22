import 'package:flutter_test/flutter_test.dart';
import 'package:driver_flutter/services/app_update_policy.dart';

const _validPlayUrl =
    'https://play.google.com/store/apps/details?id=com.netride.driver.driver_flutter';
const _validAppleUrl =
    'https://apps.apple.com/us/app/netride-driver/id123456789';

Map<String, dynamic> _raw({
  String latest = '2.1.0',
  String minimum = '2.0.0',
  int latestBuild = 21,
  int minimumBuild = 20,
  bool enabled = true,
  bool updateRequired = false,
  bool updateAvailable = false,
  String storeUrl = _validPlayUrl,
}) {
  return {
    'enabled': enabled,
    'latest_version': latest,
    'minimum_version': minimum,
    'latest_build': latestBuild,
    'minimum_build': minimumBuild,
    'store_url': storeUrl,
    'release_notes': 'Bug fixes',
    'popup_title': 'Update required',
    'popup_message': 'Please update to continue.',
    'button_text': 'Update Now',
    'supporting_text': 'This version is no longer supported.',
    'announcement_label': 'IMPORTANT UPDATE',
    'accent_color': '#5B7760',
    'update_required': updateRequired,
    'update_available': updateAvailable,
  };
}

AppUpdatePolicy _policy(Map<String, dynamic> raw, String version, int? build) {
  return buildAppUpdatePolicy(
    raw: raw,
    currentVersion: version,
    currentBuild: build,
    appId: 'driver',
    platform: 'android',
  );
}

void main() {
  test('installed version below the minimum is mandatory', () {
    final policy = _policy(_raw(), '1.9.0', 19);
    expect(policy.urgency, UpdateUrgency.required);
    expect(policy.isRequired, true);
  });

  test('installed version equal to or above the minimum is not blocked', () {
    final atMinimum = _policy(_raw(), '2.0.0', 20);
    expect(atMinimum.isRequired, false);
    expect(atMinimum.urgency, UpdateUrgency.optional);
    expect(_policy(_raw(), '2.1.0', 21).urgency, UpdateUrgency.none);
    expect(_policy(_raw(), '3.0.0', 30).urgency, UpdateUrgency.none);
  });

  test('versions between minimum and latest are optional', () {
    final policy = _policy(_raw(), '2.0.5', 21);
    expect(policy.urgency, UpdateUrgency.optional);
  });

  test('build numbers tie-break equal version names', () {
    final policy = _policy(_raw(), '2.0.0', 19);
    expect(policy.urgency, UpdateUrgency.required);
  });

  test('malformed installed versions fail open', () {
    final policy = _policy(_raw(), 'not-a-version', 1);
    expect(policy.urgency, UpdateUrgency.none);
  });

  test('disabled campaigns do not enforce an update', () {
    final policy = _policy(_raw(enabled: false), '1.0.0', 1);
    expect(policy.urgency, UpdateUrgency.none);
  });

  test('popup fields are mapped from the published configuration', () {
    final policy = _policy(_raw(), '1.0.0', 1);
    expect(policy.popupTitle, 'Update required');
    expect(policy.popupMessage, 'Please update to continue.');
    expect(policy.buttonText, 'Update Now');
    expect(policy.supportingText, 'This version is no longer supported.');
    expect(policy.announcementLabel, 'IMPORTANT UPDATE');
    expect(policy.accentColor, '#5B7760');
  });

  test('unapproved accent colors are ignored', () {
    final raw = _raw()..['accent_color'] = '#FF0000';
    expect(_policy(raw, '1.0.0', 1).accentColor, isNull);
  });

  test('store URLs must match the app platform and package', () {
    expect(
      isAllowedStoreUrl(_validPlayUrl, appId: 'driver', platform: 'android'),
      true,
    );
    expect(
      isAllowedStoreUrl(_validAppleUrl, appId: 'driver', platform: 'ios'),
      true,
    );
    expect(
      isAllowedStoreUrl(_validAppleUrl, appId: 'driver', platform: 'android'),
      false,
    );
    expect(
      isAllowedStoreUrl(_validPlayUrl, appId: 'rider', platform: 'android'),
      false,
    );
    expect(
      isAllowedStoreUrl(
        'https://evil.example/store/apps/details?id=com.netride.driver.driver_flutter',
        appId: 'driver',
        platform: 'android',
      ),
      false,
    );
    expect(
      isAllowedStoreUrl(
        'http://play.google.com/store/apps/details?id=com.netride.driver.driver_flutter',
        appId: 'driver',
        platform: 'android',
      ),
      false,
    );
  });

  test('invalid configured store URL is removed from the policy', () {
    final policy = _policy(_raw(storeUrl: 'https://evil.example/app'), '1.0.0', 1);
    expect(policy.storeUrl, isEmpty);
  });
}
