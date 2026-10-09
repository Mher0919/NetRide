// backend/src/modules/sponsor/__tests__/google-association.unit.test.ts
//
// Verifies the server-side trust boundary for Google business associations
// (spec §24): the client can never store a Place ID or business metadata that
// the backend did not itself issue from a live Google response.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseGoogleAssociation } from '../admin-sponsor.controller';
import { signSelectionToken } from '../../google-places/google-places.service';

const PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';

const token = signSelectionToken({
  p: PLACE_ID,
  n: 'Blue Bottle Coffee',
  c: 'Coffee Shop',
  a: '300 Webster St, Oakland, CA 94607, USA',
  la: 37.7964,
  ln: -122.2735,
});

test('unknown association is skipped (leaves the stored value untouched)', () => {
  const result = parseGoogleAssociation({});
  assert.ok('skip' in result);
});

test('clearing the association stores nulls', () => {
  const result = parseGoogleAssociation({ googlePlaceId: null });
  assert.ok('value' in result);
  if ('value' in result) {
    assert.equal(result.value.googlePlaceId, null);
    assert.equal(result.value.googleBusinessName, null);
    assert.equal(result.value.googlePlacesSyncedAt, null);
  }
});

test('invalid Place ID is rejected', () => {
  const result = parseGoogleAssociation({ googlePlaceId: 'not-a-place-id' });
  assert.ok('error' in result);
});

test('a Place ID without a selection token is rejected', () => {
  const result = parseGoogleAssociation({ googlePlaceId: PLACE_ID });
  assert.ok('error' in result);
});

test('a token for a different Place ID is rejected', () => {
  const result = parseGoogleAssociation({
    googlePlaceId: PLACE_ID,
    googleSelectionToken: signSelectionToken({
      p: 'ChIJSomeOtherPlaceIdLongEnough',
      n: 'Other',
      c: null,
      a: null,
      la: null,
      ln: null,
    }),
  });
  assert.ok('error' in result);
});

test('free-form client metadata is ignored — only token values are stored', () => {
  const result = parseGoogleAssociation({
    googlePlaceId: PLACE_ID,
    googleSelectionToken: token,
    googleBusinessName: 'Hacked Name',
    googleBusinessLatitude: 0,
    googleBusinessLongitude: 0,
    googleBusinessAddress: 'Fake Address',
  });
  assert.ok('value' in result);
  if ('value' in result) {
    assert.equal(result.value.googleBusinessName, 'Blue Bottle Coffee');
    assert.equal(result.value.googleBusinessLatitude, 37.7964);
    assert.equal(result.value.googleBusinessLongitude, -122.2735);
    assert.equal(result.value.googleBusinessAddress, '300 Webster St, Oakland, CA 94607, USA');
    assert.ok(result.value.googlePlacesSyncedAt instanceof Date);
  }
});
