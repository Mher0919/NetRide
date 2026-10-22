import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDraftFieldsSchema,
  createDraftRequestSchema,
  deactivateCampaignSchema,
} from '../../../../../backend/src/modules/app-version/app-update.validation';

const validDraft = {
  campaignName: 'Rider 2.1 mandatory update',
  latestVersion: '2.1.0',
  minimumVersion: '2.0.0',
  latestBuild: 21,
  minimumBuild: 20,
  storeUrl:
    'https://play.google.com/store/apps/details?id=com.netride.rider.rider_flutter',
  popupTitle: 'Update required',
  popupMessage: 'Please update NetRide to continue.',
  buttonText: 'Update Now',
  supportingText: 'This version is no longer supported.',
  announcementLabel: 'IMPORTANT UPDATE',
  accentColor: '#5B7760',
};

const riderAndroid = createDraftFieldsSchema('rider', 'android');

test('valid campaign payload passes validation', () => {
  const result = riderAndroid.safeParse(validDraft);
  assert.equal(result.success, true);
});

test('version ordering rejects a minimum above the latest', () => {
  const result = riderAndroid.safeParse({
    ...validDraft,
    latestVersion: '1.9.0',
    minimumVersion: '2.0.0',
  });
  assert.equal(result.success, false);
});

test('equal versions use build numbers for ordering', () => {
  const result = riderAndroid.safeParse({
    ...validDraft,
    latestVersion: '2.0.0',
    minimumVersion: '2.0.0',
    latestBuild: 19,
    minimumBuild: 20,
  });
  assert.equal(result.success, false);
});

test('store URL must match the target platform and app package', () => {
  const wrongPackage = riderAndroid.safeParse({
    ...validDraft,
    storeUrl:
      'https://play.google.com/store/apps/details?id=com.netride.driver.driver_flutter',
  });
  assert.equal(wrongPackage.success, false);

  const iosUrl = riderAndroid.safeParse({
    ...validDraft,
    storeUrl: 'https://apps.apple.com/us/app/netride/id123456789',
  });
  assert.equal(iosUrl.success, false);
});

test('popup copy rejects markup and enforces limits', () => {
  assert.equal(
    riderAndroid.safeParse({ ...validDraft, popupTitle: '<b>Update</b>' })
      .success,
    false,
  );
  assert.equal(
    riderAndroid.safeParse({ ...validDraft, popupMessage: 'x'.repeat(501) })
      .success,
    false,
  );
  assert.equal(
    riderAndroid.safeParse({ ...validDraft, buttonText: '' }).success,
    false,
  );
});

test('accent colors are restricted to the approved palette', () => {
  assert.equal(
    riderAndroid.safeParse({ ...validDraft, accentColor: '#FF0000' }).success,
    false,
  );
  assert.equal(
    riderAndroid.safeParse({ ...validDraft, accentColor: null }).success,
    true,
  );
});

test('draft requests require an expected revision', () => {
  const schema = createDraftRequestSchema('rider', 'android');
  assert.equal(schema.safeParse(validDraft).success, false);
  assert.equal(
    schema.safeParse({ ...validDraft, expectedRevision: 3 }).success,
    true,
  );
});

test('deactivation requires a revision and rejects markup in the reason', () => {
  assert.equal(
    deactivateCampaignSchema.safeParse({ expectedRevision: 4 }).success,
    true,
  );
  assert.equal(
    deactivateCampaignSchema.safeParse({
      expectedRevision: 4,
      reason: '<script>alert(1)</script>',
    }).success,
    false,
  );
});
