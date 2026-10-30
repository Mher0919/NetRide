import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAppVersionEnforcement,
  isExemptFromAppUpdateEnforcement,
} from '../../../../../backend/src/middleware/appVersion.middleware';
import { DEFAULT_RELEASE_CONFIGS } from '../../../../../backend/src/modules/app-version/app-version.utils';

const activeConfig = {
  ...DEFAULT_RELEASE_CONFIGS.rider.android,
  minimumVersion: '2.0.0',
  latestVersion: '2.1.0',
  minimumBuild: 20,
  latestBuild: 21,
  storeUrl:
    'https://play.google.com/store/apps/details?id=com.netride.rider.rider_flutter',
  isActive: true,
};

function buildRequest(
  path: string,
  headers: Record<string, string> = {},
  method = 'POST',
) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    method,
    path,
    header: (name: string) => normalized[name.toLowerCase()],
  } as any;
}

function buildResponse() {
  const state: {
    statusCode: number;
    body: any;
    headers: Record<string, string>;
  } = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(body: any) {
      state.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return res;
    },
  } as any;
  return { res, state };
}

function runMiddleware(
  middleware: any,
  req: any,
): Promise<{ nextCalled: boolean; state: any }> {
  return new Promise(resolve => {
    let nextCalled = false;
    const { res, state } = buildResponse();
    middleware(req, res, () => {
      nextCalled = true;
      resolve({ nextCalled, state });
    }).then?.(() => {
      if (nextCalled) return;
      setTimeout(() => resolve({ nextCalled, state }), 0);
    });
  });
}

test('exempt paths never enforce app version requirements', () => {
  assert.equal(isExemptFromAppUpdateEnforcement('GET', '/api/app/version'), true);
  assert.equal(isExemptFromAppUpdateEnforcement('POST', '/api/auth/oauth'), true);
  assert.equal(isExemptFromAppUpdateEnforcement('GET', '/api/admin/users'), true);
  assert.equal(isExemptFromAppUpdateEnforcement('GET', '/health'), true);
  assert.equal(isExemptFromAppUpdateEnforcement('POST', '/api/ride/request'), false);
});

test('requests without app headers are allowed (web and legacy clients)', async () => {
  const middleware = createAppVersionEnforcement({
    getConfig: async () => activeConfig,
  });
  const { nextCalled } = await runMiddleware(
    middleware,
    buildRequest('/api/ride/request'),
  );
  assert.equal(nextCalled, true);
});

test('an installed version below the minimum receives 426', async () => {
  const middleware = createAppVersionEnforcement({
    getConfig: async () => activeConfig,
  });
  const { nextCalled, state } = await runMiddleware(
    middleware,
    buildRequest('/api/ride/request', {
      'x-app-id': 'rider',
      'x-app-platform': 'android',
      'x-app-version': '1.9.0',
      'x-app-build': '19',
    }),
  );
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 426);
  assert.equal(state.body.code, 'APP_UPDATE_REQUIRED');
  assert.equal(state.body.minimum_version, '2.0.0');
  assert.equal(state.headers['X-Minimum-Supported-Version'], '2.0.0');
});

test('a supported version continues normally', async () => {
  const middleware = createAppVersionEnforcement({
    getConfig: async () => activeConfig,
  });
  for (const version of ['2.0.0', '2.1.0', '3.0.0']) {
    const { nextCalled } = await runMiddleware(
      middleware,
      buildRequest('/api/ride/request', {
        'x-app-id': 'rider',
        'x-app-platform': 'android',
        'x-app-version': version,
        'x-app-build': '20',
      }),
    );
    assert.equal(nextCalled, true, version);
  }
});

test('inactive release configs do not block protected operations', async () => {
  const middleware = createAppVersionEnforcement({
    getConfig: async () => ({
      ...activeConfig,
      isActive: false,
    }),
  });
  const { nextCalled } = await runMiddleware(
    middleware,
    buildRequest('/api/ride/request', {
      'x-app-id': 'rider',
      'x-app-platform': 'android',
      'x-app-version': '1.0.0',
    }),
  );
  assert.equal(nextCalled, true);
});

test('partial app headers are rejected instead of silently bypassing', async () => {
  const middleware = createAppVersionEnforcement({
    getConfig: async () => activeConfig,
  });
  const { nextCalled, state } = await runMiddleware(
    middleware,
    buildRequest('/api/ride/request', {
      'x-app-id': 'rider',
      'x-app-version': '1.0.0',
    }),
  );
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 400);
  assert.equal(state.body.code, 'INVALID_APP_PLATFORM');
});

test('malformed versions and policy lookup failures fail open', async () => {
  const malformed = createAppVersionEnforcement({
    getConfig: async () => activeConfig,
  });
  const malformedResult = await runMiddleware(
    malformed,
    buildRequest('/api/ride/request', {
      'x-app-id': 'rider',
      'x-app-platform': 'android',
      'x-app-version': 'not-a-version',
    }),
  );
  assert.equal(malformedResult.nextCalled, true);

  const unavailable = createAppVersionEnforcement({
    getConfig: async () => {
      throw new Error('database offline');
    },
  });
  const unavailableResult = await runMiddleware(
    unavailable,
    buildRequest('/api/ride/request', {
      'x-app-id': 'rider',
      'x-app-platform': 'android',
      'x-app-version': '1.0.0',
    }),
  );
  assert.equal(unavailableResult.nextCalled, true);
});
