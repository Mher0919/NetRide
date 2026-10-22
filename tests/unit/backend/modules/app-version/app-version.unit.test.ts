import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_IDS,
  APP_PLATFORMS,
  DEFAULT_RELEASE_CONFIGS,
  compareVersions,
  evaluateVersion,
  isAllowedStoreUrl,
  isBelowVersion,
  isValidVersion,
} from '../../../../../backend/src/modules/app-version/app-version.utils';

const baseConfig = {
  latestVersion: '2.0.0',
  minimumVersion: '1.0.0',
  latestBuild: 20,
  minimumBuild: 10,
};

test('compareVersions orders dotted numeric versions', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareVersions('1.2.0', '1.10.0'), -1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('10.0.0', '9.9.9'), 1);
});

test('compareVersions accepts build metadata and ignores it for name ordering', () => {
  assert.equal(compareVersions('1.0.0+12', '1.0.0+5'), 0);
  assert.equal(compareVersions('1.0.1+1', '1.0.0+99'), 1);
});

test('compareVersions fails safe for malformed versions', () => {
  assert.equal(compareVersions('', '1.0.0'), 0);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0.beta', '1.0.0'), 0);
});

test('isValidVersion only accepts store-style numeric versions', () => {
  assert.equal(isValidVersion('1.0.0'), true);
  assert.equal(isValidVersion('12.34.56.78'), true);
  assert.equal(isValidVersion('1'), false);
  assert.equal(isValidVersion('1.0.0-beta'), false);
  assert.equal(isValidVersion('v1.0.0'), false);
});

test('isBelowVersion uses build number when version names are equal', () => {
  assert.equal(isBelowVersion('1.0.0', 9, '1.0.0', 10), true);
  assert.equal(isBelowVersion('1.0.0', 10, '1.0.0', 10), false);
  assert.equal(isBelowVersion('1.0.0', 11, '1.0.0', 10), false);
  assert.equal(isBelowVersion('1.0.0', null, '1.0.0', 10), false);
  assert.equal(isBelowVersion('1.0.0', 9, '1.0.0', null), false);
});

test('evaluateVersion returns optional update when current is between minimum and latest', () => {
  assert.deepEqual(evaluateVersion(baseConfig, '1.5.0', 15), {
    updateRequired: false,
    updateAvailable: true,
  });
});

test('evaluateVersion returns forced update when current is below minimum', () => {
  assert.deepEqual(evaluateVersion(baseConfig, '0.9.0', 9), {
    updateRequired: true,
    updateAvailable: true,
  });
});

test('evaluateVersion returns no update when current is up to date', () => {
  assert.deepEqual(evaluateVersion(baseConfig, '2.0.0', 20), {
    updateRequired: false,
    updateAvailable: false,
  });
});

test('evaluateVersion forces update on an equal version with an older build', () => {
  assert.deepEqual(evaluateVersion(baseConfig, '1.0.0', 9), {
    updateRequired: true,
    updateAvailable: true,
  });
});

test('evaluateVersion fails open when the installed version is malformed', () => {
  assert.deepEqual(evaluateVersion(baseConfig, 'not-a-version', 1), {
    updateRequired: false,
    updateAvailable: false,
  });
});

test('store URLs must be the canonical HTTPS listing for the target app', () => {
  const riderAndroid =
    'https://play.google.com/store/apps/details?id=com.netride.rider.rider_flutter';
  const driverAndroid =
    'https://play.google.com/store/apps/details?id=com.netride.driver.driver_flutter';
  const riderIos = 'https://apps.apple.com/us/app/netride/id123456789';

  assert.equal(isAllowedStoreUrl(riderAndroid, 'rider', 'android'), true);
  assert.equal(isAllowedStoreUrl(driverAndroid, 'driver', 'android'), true);
  assert.equal(isAllowedStoreUrl(riderIos, 'rider', 'ios'), true);
  assert.equal(isAllowedStoreUrl(riderAndroid, 'driver', 'android'), false);
  assert.equal(isAllowedStoreUrl(riderAndroid, 'rider', 'ios'), false);
  assert.equal(isAllowedStoreUrl(riderIos, 'rider', 'android'), false);
  assert.equal(
    isAllowedStoreUrl(
      'http://play.google.com/store/apps/details?id=com.netride.rider.rider_flutter',
      'rider',
      'android',
    ),
    false,
  );
  assert.equal(
    isAllowedStoreUrl(
      'https://evil.example/store/apps/details?id=com.netride.rider.rider_flutter',
      'rider',
      'android',
    ),
    false,
  );
  assert.equal(
    isAllowedStoreUrl(
      'https://apps.apple.com/us/search?term=NetRide',
      'rider',
      'ios',
    ),
    false,
  );
  assert.equal(
    isAllowedStoreUrl(
      'https://user:pass@play.google.com/store/apps/details?id=com.netride.rider.rider_flutter',
      'rider',
      'android',
    ),
    false,
  );
});

test('default release configs cover every app and platform', () => {
  for (const app of APP_IDS) {
    for (const platform of APP_PLATFORMS) {
      const config = DEFAULT_RELEASE_CONFIGS[app][platform];
      assert.equal(config.app, app);
      assert.equal(config.platform, platform);
      assert.equal(isValidVersion(config.latestVersion), true);
      assert.equal(isValidVersion(config.minimumVersion), true);
      assert.ok(compareVersions(config.latestVersion, config.minimumVersion) >= 0);
      assert.equal(config.storeUrl, '');
      assert.equal(config.campaignStatus, 'PUBLISHED');
      assert.ok(config.popupTitle.length > 0);
      assert.ok(config.popupMessage.length > 0);
    }
  }
});
