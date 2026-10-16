// tests/unit/backend/security/zod-dos.unit.test.ts
//
// CVE-2023-54404 / GHSA-mrhx-c7xc-m3w5 regression suite: zod array validation
// must not fan out into one issue object per element on hostile input, and
// the request boundary must reject absurd JSON shapes before any schema runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { safeParseBounded } from '../../../../backend/src/utils/zod-parse';
import {
  DEFAULT_JSON_SHAPE_LIMITS,
  findShapeViolation,
  jsonShapeGuard,
} from '../../../../backend/src/middleware/jsonShapeGuard.middleware';
import { validate } from '../../../../backend/src/middleware/validate.middleware';

test('zod: installed version includes the abortEarly mitigation (>=4.6.6)', () => {
  const pkgPath = path.resolve(__dirname, '../../../../backend/node_modules/zod/package.json');
  const { version } = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const [major, minor] = String(version).split('.').map(Number);
  assert.ok(
    major > 4 || (major === 4 && minor >= 6),
    `zod ${version} predates the CVE-2023-54404 mitigation`,
  );
});

test('zod: abortEarly collapses per-element issues on hostile arrays', () => {
  const schema = z.array(z.number());
  const hostile: unknown[] = new Array(20_000).fill('not-a-number');

  // Default behavior: one issue per failing element (the amplification the
  // advisory describes). Pinned so a future zod change is visible here.
  const unbounded = schema.safeParse(hostile);
  assert.equal(unbounded.success, false);
  assert.equal(unbounded.error!.issues.length, hostile.length);

  const started = Date.now();
  const bounded = safeParseBounded(schema, hostile);
  const elapsedMs = Date.now() - started;
  assert.equal(bounded.success, false);
  assert.ok(
    bounded.error!.issues.length <= 5,
    `bounded parse produced ${bounded.error!.issues.length} issues`,
  );
  assert.ok(elapsedMs < 2_000, `bounded parse took ${elapsedMs}ms`);
});

test('zod: bounded parsing keeps valid payloads identical', () => {
  const schema = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) });
  const valid = { ids: ['123e4567-e89b-12d3-a456-426614174000'] };
  const plain = schema.safeParse(valid);
  const bounded = safeParseBounded(schema, valid);
  assert.equal(bounded.success, true);
  assert.deepEqual(bounded.data, plain.data);
});

test('shape guard: oversized arrays are rejected, normal ones pass', () => {
  const max = DEFAULT_JSON_SHAPE_LIMITS.maxArrayLength;
  assert.equal(findShapeViolation({ ids: new Array(max).fill('x') }), null);
  assert.ok(findShapeViolation({ ids: new Array(max + 1).fill('x') }));
});

test('shape guard: deep nesting is rejected at the configured depth', () => {
  let deep: any = 1;
  for (let i = 0; i < DEFAULT_JSON_SHAPE_LIMITS.maxDepth + 2; i++) deep = { a: deep };
  assert.ok(findShapeViolation(deep));
  assert.equal(findShapeViolation({ a: { b: { c: [1, 2, 3] } } }), null);
});

test('shape guard: oversized objects are rejected, scalars ignored', () => {
  const wide: Record<string, number> = {};
  for (let i = 0; i <= DEFAULT_JSON_SHAPE_LIMITS.maxObjectKeys; i++) wide[`k${i}`] = i;
  assert.ok(findShapeViolation(wide));
  assert.equal(findShapeViolation('string'), null);
  assert.equal(findShapeViolation(42), null);
  assert.equal(findShapeViolation(null), null);
});

// --- HTTP boundary integration ---------------------------------------------

function listen(app: any): Promise<{ server: any; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

test('http: hostile array body is rejected at the boundary, valid body accepted', async () => {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use(jsonShapeGuard());
  app.post(
    '/ids',
    validate(z.object({ body: z.object({ ids: z.array(z.string().uuid()).max(100) }) })),
    (_req: any, res: any) => res.json({ ok: true }),
  );
  const { server, port } = await listen(app);
  try {
    const hostile = await fetch(`http://127.0.0.1:${port}/ids`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ids: new Array(DEFAULT_JSON_SHAPE_LIMITS.maxArrayLength + 1).fill('x'),
      }),
    });
    assert.equal(hostile.status, 413);

    const wrongTypes = await fetch(`http://127.0.0.1:${port}/ids`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [1, 2, 3] }),
    });
    assert.equal(wrongTypes.status, 400);
    const wrongBody: any = await wrongTypes.json();
    // The bounded parse reports a single detail, not one per element.
    assert.ok(Array.isArray(wrongBody.details));
    assert.ok(wrongBody.details.length <= 5, `details=${wrongBody.details.length}`);

    const valid = await fetch(`http://127.0.0.1:${port}/ids`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['123e4567-e89b-12d3-a456-426614174000'] }),
    });
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), { ok: true });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
