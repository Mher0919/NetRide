// backend/src/modules/google-places/__tests__/google-places.unit.test.ts
//
// Unit tests for the Google Places proxy's pure logic — token signing,
// photo signatures, DTO shaping and graceful missing-field handling.
// No network, no DB, no Redis: Google itself is never contacted (spec §37
// allows mocks in tests only).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatCategory,
  isValidPlaceId,
  photoSignature,
  priceLevelLabel,
  shapeDetails,
  shapeSuggestion,
  signSelectionToken,
  verifyPhotoSignature,
  verifySelectionToken,
  type GoogleSelectionPayload,
} from '../google-places.service';

const PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';

const payload: GoogleSelectionPayload = {
  p: PLACE_ID,
  n: 'Blue Bottle Coffee',
  c: 'Coffee Shop',
  a: '300 Webster St, Oakland, CA 94607, USA',
  la: 37.7964,
  ln: -122.2735,
};

test('isValidPlaceId: accepts Google-shaped ids and rejects junk', () => {
  assert.equal(isValidPlaceId(PLACE_ID), true);
  assert.equal(isValidPlaceId(' places/abc '), false);
  assert.equal(isValidPlaceId('short'), false);
  assert.equal(isValidPlaceId('has spaces in it 123456'), false);
  assert.equal(isValidPlaceId(''), false);
  assert.equal(isValidPlaceId(null), false);
  assert.equal(isValidPlaceId(1234567890123), false);
});

test('selection token: signed payload round-trips', () => {
  const token = signSelectionToken(payload);
  const verified = verifySelectionToken(token);
  assert.ok(verified);
  assert.equal(verified!.p, PLACE_ID);
  assert.equal(verified!.n, payload.n);
  assert.equal(verified!.c, payload.c);
  assert.equal(verified!.a, payload.a);
  assert.equal(verified!.la, payload.la);
  assert.equal(verified!.ln, payload.ln);
});

test('selection token: tampering and garbage are rejected', () => {
  const token = signSelectionToken(payload);
  const [body, sig] = token.split('.');
  const forgedBody = Buffer.from(
    JSON.stringify({ ...payload, p: 'ChIJforgedPlaceIdThatIsLongEnough' }),
  ).toString('base64url');

  assert.equal(verifySelectionToken(`${forgedBody}.${sig}`), null);
  assert.equal(verifySelectionToken(`${body}.deadbeef`), null);
  assert.equal(verifySelectionToken('not-a-token'), null);
  assert.equal(verifySelectionToken(undefined), null);
  assert.equal(verifySelectionToken(`a.${sig}`), null);
});

test('selection token: expired tokens are rejected', () => {
  const expired = signSelectionToken(payload, -1000);
  assert.equal(verifySelectionToken(expired), null);
});

test('photo signature: binds the resource name and width', () => {
  const name = 'places/ChIJN1t_tDeuEmsRUsoyG83frY4/photos/AbCdEf';
  const sig = photoSignature(name, 1200);
  assert.equal(verifyPhotoSignature(name, 1200, sig), true);
  assert.equal(verifyPhotoSignature(name, 800, sig), false);
  assert.equal(verifyPhotoSignature('places/other/photos/x', 1200, sig), false);
  assert.equal(verifyPhotoSignature(name, 1200, undefined), false);
});

test('formatCategory: prefers the display name, skips generic types', () => {
  assert.equal(
    formatCategory({ primaryTypeDisplayName: { text: 'Coffee Shop' }, types: ['cafe'] }),
    'Coffee Shop',
  );
  assert.equal(formatCategory({ types: ['point_of_interest', 'cafe'] }), 'Cafe');
  assert.equal(formatCategory({ types: ['point_of_interest', 'establishment'] }), null);
});

test('priceLevelLabel: maps Google price levels', () => {
  assert.equal(priceLevelLabel('PRICE_LEVEL_INEXPENSIVE'), '$');
  assert.equal(priceLevelLabel('PRICE_LEVEL_VERY_EXPENSIVE'), '$$$$');
  assert.equal(priceLevelLabel('PRICE_LEVEL_UNSPECIFIED'), null);
});

test('shapeSuggestion: maps a live Google row and signs a selection token', () => {
  const raw = {
    id: PLACE_ID,
    displayName: { text: 'Blue Bottle Coffee' },
    formattedAddress: '300 Webster St, Oakland, CA 94607, USA',
    shortFormattedAddress: '300 Webster St',
    location: { latitude: 37.7964, longitude: -122.2735 },
    primaryTypeDisplayName: { text: 'Coffee Shop' },
    types: ['coffee_shop', 'cafe'],
    rating: 4.53,
    userRatingCount: 1284,
    photos: [
      {
        name: 'places/ChIJN1t_tDeuEmsRUsoyG83frY4/photos/AbCdEf',
        widthPx: 4032,
        heightPx: 3024,
        authorAttributions: [{ displayName: 'Jane Doe', uri: 'https://maps.google.com/x' }],
      },
    ],
  };
  const row = shapeSuggestion(raw, { lat: 37.7951, lon: -122.2795 });
  assert.ok(row);
  assert.equal(row!.placeId, PLACE_ID);
  assert.equal(row!.name, 'Blue Bottle Coffee');
  assert.equal(row!.category, 'Coffee Shop');
  assert.equal(row!.rating, 4.5);
  assert.equal(row!.reviewCount, 1284);
  assert.ok(row!.distanceMiles != null && row!.distanceMiles! > 0);
  assert.ok(row!.photoUrl!.startsWith('/api/places/photo?name='));
  assert.equal(row!.photoAttribution?.displayName, 'Jane Doe');
  const verified = verifySelectionToken(row!.selectionToken);
  assert.equal(verified?.p, PLACE_ID);
});

test('shapeSuggestion: malformed rows return null instead of throwing', () => {
  assert.equal(shapeSuggestion({}), null);
  assert.equal(shapeSuggestion({ id: 'too-short' }), null);
  assert.equal(shapeSuggestion({ id: PLACE_ID }), null);
});

test('shapeDetails basic: identity + rating, no enterprise fields', () => {
  const raw = {
    id: PLACE_ID,
    displayName: { text: 'Blue Bottle Coffee' },
    formattedAddress: '300 Webster St, Oakland, CA 94607, USA',
    location: { latitude: 37.7964, longitude: -122.2735 },
    primaryTypeDisplayName: { text: 'Coffee Shop' },
    rating: 4.5,
    userRatingCount: 1284,
    googleMapsUri: 'https://maps.google.com/?cid=1',
    businessStatus: 'OPERATIONAL',
    priceLevel: 'PRICE_LEVEL_MODERATE',
    photos: [{ name: 'places/x/photos/y', widthPx: 100, heightPx: 100 }],
    internationalPhoneNumber: '+1 510-555-0100',
    websiteUri: 'https://bluebottlecoffee.com',
    regularOpeningHours: { openNow: true, weekdayDescriptions: ['Monday: 7–5'] },
    reviews: [{ rating: 5, text: { text: 'Great coffee' }, authorAttribution: { displayName: 'A' } }],
  };
  const basic = shapeDetails(raw, 'basic');
  assert.equal(basic.placeId, PLACE_ID);
  assert.equal(basic.name, 'Blue Bottle Coffee');
  assert.equal(basic.rating, 4.5);
  assert.equal(basic.phone, null);
  assert.equal(basic.website, null);
  assert.equal(basic.reviews.length, 0);
  assert.equal(basic.photos.length, 1);
  assert.equal(basic.openNow, true);
  assert.equal(basic.attribution, 'Powered by Google');

  const full = shapeDetails(raw, 'full');
  assert.equal(full.phone, '+1 510-555-0100');
  assert.equal(full.website, 'https://bluebottlecoffee.com');
  assert.equal(full.reviews.length, 1);
  assert.equal(full.reviews[0].authorName, 'A');
  assert.equal(full.reviews[0].text, 'Great coffee');
  assert.equal(full.level, 'full');
});

test('shapeDetails: missing fields degrade gracefully, never throw', () => {
  const shaped = shapeDetails({ id: PLACE_ID }, 'full');
  assert.equal(shaped.name, 'Business');
  assert.equal(shaped.rating, null);
  assert.equal(shaped.reviewCount, null);
  assert.equal(shaped.latitude, null);
  assert.equal(shaped.openNow, null);
  assert.deepEqual(shaped.weekdayDescriptions, []);
  assert.deepEqual(shaped.reviews, []);
  assert.deepEqual(shaped.photos, []);

  const noId = shapeDetails({}, 'basic');
  assert.equal(noId.placeId, '');
});
