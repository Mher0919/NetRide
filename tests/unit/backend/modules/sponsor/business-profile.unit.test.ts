// tests/unit/backend/modules/sponsor/business-profile.unit.test.ts
//
// Manual business-entry (Add Manually) validation: image references must
// point at uploaded NetRide storage files, and the profile fields must be
// bounded. These are the pure helpers the controller enforces.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseStoredImageUrl } from '../../../../../backend/src/modules/sponsor/admin-sponsor.controller';

const FILE_ID = '4f0e8c2a-1b2c-4d5e-8f90-abcdefabcdef';

test('image refs: relative storage URLs are accepted and normalised', () => {
  const parsed = parseStoredImageUrl(`/api/files/${FILE_ID}`);
  assert.deepEqual(parsed, { fileId: FILE_ID, url: `/api/files/${FILE_ID}` });
});

test('image refs: absolute same-path URLs are accepted (response interceptor)', () => {
  const parsed = parseStoredImageUrl(`https://netride.onrender.com/api/files/${FILE_ID}`);
  assert.equal(parsed?.url, `/api/files/${FILE_ID}`);
});

test('image refs: external or malformed URLs are rejected', () => {
  assert.equal(parseStoredImageUrl('https://evil.example.com/logo.png'), null);
  assert.equal(parseStoredImageUrl('https://evil.example.com/api/files/../../etc/passwd'), null);
  assert.equal(parseStoredImageUrl('/api/files/not-a-uuid'), null);
  assert.equal(parseStoredImageUrl('data:image/png;base64,AAAA'), null);
  assert.equal(parseStoredImageUrl('javascript:alert(1)'), null);
  assert.equal(parseStoredImageUrl(''), null);
  assert.equal(parseStoredImageUrl(null), null);
  assert.equal(parseStoredImageUrl(42), null);
  assert.equal(parseStoredImageUrl(`/api/files/${FILE_ID}?x=1`), null);
});
