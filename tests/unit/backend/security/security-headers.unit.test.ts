// tests/unit/backend/security/security-headers.unit.test.ts
//
// Finding A regression suite: the security-header policy must be present on
// every response path (success, redirect, error) and HSTS must only be sent
// for requests that actually arrived over TLS.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { securityHeaders } from '../../../../backend/src/middleware/securityHeaders.middleware';

function buildApp() {
  const app = express();
  // Mirrors app.ts: one trusted proxy hop (Render) so req.secure reflects
  // X-Forwarded-Proto, and no framework fingerprint header.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.get('/ok', (_req, res) => res.json({ ok: true }));
  app.get('/go', (_req, res) => res.redirect('/ok'));
  app.get('/boom', () => {
    throw new Error('boom');
  });
  app.use((_err: any, _req: any, res: any, _next: any) =>
    res.status(500).json({ error: 'internal' }),
  );
  return app;
}

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

function close(server: any): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('headers: baseline policy is present on success, redirect and error', async () => {
  const { server, port } = await listen(buildApp());
  try {
    for (const route of ['/ok', '/go', '/boom']) {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, { redirect: 'manual' });
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', route);
      assert.equal(res.headers.get('x-frame-options'), 'DENY', route);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer', route);
      assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/, route);
      assert.match(res.headers.get('permissions-policy') ?? '', /geolocation=\(\)/, route);
      assert.equal(res.headers.get('x-powered-by'), null, route);
      // Plain HTTP must NOT receive HSTS (local development).
      assert.equal(res.headers.get('strict-transport-security'), null, route);
    }
    const redirect = await fetch(`http://127.0.0.1:${port}/go`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
  } finally {
    await close(server);
  }
});

test('headers: HSTS is sent when the request arrived over TLS', async () => {
  const { server, port } = await listen(buildApp());
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ok`, {
      headers: { 'x-forwarded-proto': 'https' },
    });
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=15552000');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await close(server);
  }
});
