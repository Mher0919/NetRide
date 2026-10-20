// tests/unit/backend/modules/sponsor/sponsor-portal-settings.unit.test.ts
//
// Policy tests for the sponsor (colab) settings whitelist. NetRide admin owns
// the rider-facing business identity — in particular the business DESCRIPTION
// shown on SPECIALS. A sponsor portal identity may only update operational
// contact/address fields, and a PATCH that tries to touch an admin-owned field
// must be REJECTED (not silently ignored).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSponsorPortalSettingsPatch,
  SponsorPortalFieldForbiddenError,
  SPONSOR_PORTAL_EDITABLE_FIELDS,
  SPONSOR_PORTAL_ADMIN_ONLY_FIELDS,
} from '../../../../../backend/src/modules/sponsor/sponsor-portal.settings';

test('description is never an editable sponsor-portal field', () => {
  assert.equal(
    (SPONSOR_PORTAL_EDITABLE_FIELDS as readonly string[]).includes('business_description'),
    false,
  );
  assert.equal(
    (SPONSOR_PORTAL_EDITABLE_FIELDS as readonly string[]).includes('businessDescription'),
    false,
  );
  assert.equal(
    (SPONSOR_PORTAL_ADMIN_ONLY_FIELDS as readonly string[]).includes('business_description'),
    true,
  );
});

test('allowed contact/address fields pass through unchanged', () => {
  const patch = buildSponsorPortalSettingsPatch({
    manager_name: 'Dana',
    phone: '+1 555 0100',
    email: 'dana@example.com',
    other_contact_info: 'ring twice',
    address: '1 Main St',
    city: 'Los Angeles',
    state: 'CA',
    postal_code: '90001',
    country: 'US',
  });
  assert.deepEqual(patch, {
    manager_name: 'Dana',
    phone: '+1 555 0100',
    email: 'dana@example.com',
    other_contact_info: 'ring twice',
    address: '1 Main St',
    city: 'Los Angeles',
    state: 'CA',
    postal_code: '90001',
    country: 'US',
  });
});

test('description (snake_case) is rejected with a typed 403 error', () => {
  assert.throws(
    () => buildSponsorPortalSettingsPatch({ business_description: 'New copy' }),
    (err: any) => {
      assert.equal(err instanceof SponsorPortalFieldForbiddenError, true);
      assert.equal(err.code, 'SPONSOR_FIELD_FORBIDDEN');
      assert.equal(err.field, 'business_description');
      return true;
    },
  );
});

test('description (camelCase) is rejected too — no casing bypass', () => {
  assert.throws(
    () => buildSponsorPortalSettingsPatch({ businessDescription: 'New copy' }),
    (err: any) => err instanceof SponsorPortalFieldForbiddenError,
  );
});

test('business identity fields are admin-owned and rejected', () => {
  for (const field of [
    'business_name',
    'businessName',
    'business_type',
    'businessType',
  ]) {
    assert.throws(
      () => buildSponsorPortalSettingsPatch({ [field]: 'x' }),
      (err: any) => err instanceof SponsorPortalFieldForbiddenError,
      `${field} must be rejected`,
    );
  }
});

test('a forbidden field rejects the WHOLE patch (nothing is silently saved)', () => {
  assert.throws(
    () =>
      buildSponsorPortalSettingsPatch({
        phone: '+1 555 0101',
        business_description: 'Sneaky copy',
      }),
    (err: any) => err instanceof SponsorPortalFieldForbiddenError,
  );
});

test('unknown/financial fields are ignored, not forwarded', () => {
  const patch = buildSponsorPortalSettingsPatch({
    phone: '+1 555 0102',
    discount_fixed_amount_cents: 1,
    status: 'ACTIVE',
  });
  assert.deepEqual(patch, { phone: '+1 555 0102' });
});

test('empty or missing bodies produce an empty patch', () => {
  assert.deepEqual(buildSponsorPortalSettingsPatch({}), {});
  assert.deepEqual(buildSponsorPortalSettingsPatch(null), {});
  assert.deepEqual(buildSponsorPortalSettingsPatch(undefined), {});
});
