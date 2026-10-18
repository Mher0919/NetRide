// tests/unit/backend/security/image-content.unit.test.ts
//
// Regression suite for content-based image validation used by the sponsor
// business-image uploads. Extensions and client MIME types are spoofable, so
// the bytes must decide.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectImageMime,
  imageMimeMatches,
} from '../../../../backend/src/security/image-content';

function jpeg(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 1)]);
}

function png(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16, 2),
  ]);
}

function webp(): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('WEBP', 'latin1'),
    Buffer.alloc(8, 3),
  ]);
}

function heic(brand = 'heic'): Buffer {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftyp', 'latin1'),
    Buffer.from(brand, 'latin1'),
    Buffer.alloc(8, 4),
  ]);
}

test('sniffing: real image headers are detected', () => {
  assert.equal(detectImageMime(jpeg()), 'image/jpeg');
  assert.equal(detectImageMime(png()), 'image/png');
  assert.equal(detectImageMime(webp()), 'image/webp');
  assert.equal(detectImageMime(heic('heic')), 'image/heic');
  assert.equal(detectImageMime(heic('heix')), 'image/heic');
  assert.equal(detectImageMime(heic('heif')), 'image/heif');
  assert.equal(detectImageMime(heic('mif1')), 'image/heif');
});

test('sniffing: non-image content is rejected regardless of declared type', () => {
  assert.equal(detectImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(detectImageMime(Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.equal(detectImageMime(Buffer.from('GIF89a............')), null);
  assert.equal(detectImageMime(Buffer.from([0x25, 0x50, 0x44, 0x46])), null); // %PDF
  assert.equal(detectImageMime(Buffer.alloc(0)), null);
  assert.equal(detectImageMime(null), null);
  assert.equal(detectImageMime(undefined), null);
});

test('matching: declared MIME must agree with detected content', () => {
  assert.equal(imageMimeMatches('image/jpeg', 'image/jpeg'), true);
  assert.equal(imageMimeMatches('image/jpg', 'image/jpeg'), true);
  assert.equal(imageMimeMatches('image/png', 'image/png'), true);
  assert.equal(imageMimeMatches('image/heic', 'image/heif'), true);
  assert.equal(imageMimeMatches('image/heif', 'image/heic'), true);
  assert.equal(imageMimeMatches('image/png', 'image/jpeg'), false);
  assert.equal(imageMimeMatches('image/jpeg', 'image/png'), false);
  assert.equal(imageMimeMatches('image/webp', 'image/heic'), false);
});

test('sniffing: a JPEG declared as PNG would be rejected end-to-end', () => {
  const detected = detectImageMime(jpeg());
  assert.equal(detected, 'image/jpeg');
  assert.equal(imageMimeMatches('image/png', detected!), false);
});
