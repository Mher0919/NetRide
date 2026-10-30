import 'package:flutter_test/flutter_test.dart';
import 'package:rider_flutter/services/app_update_policy.dart';

const _validPlayUrl =
    'https://play.google.com/store/apps/details?id=com.netride.rider.rider_flutter';
const _validAppleUrl =
    'https://apps.apple.com/us/app/netride/id123456789';

Map<String, dynamic> _raw({
  String latest = '2.1.0',
  String minimum = '2.0.0',
  int latestBuild = 21,
  int minimumBuild = 20,
  bool enabled = true,
  bool updateRequired = false,
  String storeUrl = _validPlayUrl,
}) {
  return {
    'enabled': enabled,
    'latest_version': latest,
    'minimum_version': minimum,
    'latest_build': latestBuild,
    'minimum_build': minimumBuild,
    'store_url': storeUrl,
    'update_required': updateRequired,
  };
}

AppUpdatePolicy _policy(Map<String, dynamic> raw, String version, int? build) {
  return buildAppUpdatePolicy(
    raw: raw,
    currentVersion: version,
    currentBuild: build,
    appId: 'rider',
    platform: 'android',
  );
}

void main() {
  test('installed version below the minimum requires an update', () {
    final policy = _policy(_raw(), '1.9.0', 19);
    expect(policy.urgency, UpdateUrgency.required);
    expect(policy.isRequired, true);
  });

  test('installed version at or above the minimum is not blocked', () {
    expect(_policy(_raw(), '2.0.0', 20).isRequired, false);
    expect(_policy(_raw(), '2.1.0', 21).urgency, UpdateUrgency.none);
    expect(_policy(_raw(), '3.0.0', 30).urgency, UpdateUrgency.none);
  });

  test('versions between minimum and latest are not prompted', () {
    final policy = _policy(_raw(), '2.0.5', 21);
    expect(policy.urgency, UpdateUrgency.none);
  });

  test('build numbers tie-break equal version names', () {
    final policy = _policy(_raw(), '2.0.0', 19);
    expect(policy.urgency, UpdateUrgency.required);
  });

  test('malformed installed versions fail open', () {
    final policy = _policy(_raw(), 'not-a-version', 1);
    expect(policy.urgency, UpdateUrgency.none);
  });

  test('disabled release configs do not enforce an update', () {
    final policy = _policy(_raw(enabled: false), '1.0.0', 1);
    expect(policy.urgency, UpdateUrgency.none);
  });

  test('store URLs must match the app platform and package', () {
    expect(
      isAllowedStoreUrl(_validPlayUrl, appId: 'rider', platform: 'android'),
      true,
    );
    expect(
      isAllowedStoreUrl(_validAppleUrl, appId: 'rider', platform: 'ios'),
      true,
    );
    expect(
      isAllowedStoreUrl(_validAppleUrl, appId: 'rider', platform: 'android'),
      false,
    );
    expect(
      isAllowedStoreUrl(_validPlayUrl, appId: 'driver', platform: 'android'),
      false,
    );
    expect(
      isAllowedStoreUrl(
        'https://evil.example/store/apps/details?id=com.netride.rider.rider_flutter',
        appId: 'rider',
        platform: 'android',
      ),
      false,
    );
    expect(
      isAllowedStoreUrl(
        'http://play.google.com/store/apps/details?id=com.netride.rider.rider_flutter',
        appId: 'rider',
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
