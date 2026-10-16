// tests/security/run-security-checks.cjs
//
// Cross-cutting security regression checks that cannot live inside the
// backend unit runner because they exercise the two dashboard servers and the
// mobile platform configuration:
//
//   Finding A — security headers on the admin + sponsor portals
//               (success, 404 and TLS/non-TLS HSTS behavior)
//   Finding D — mobile TLS configuration invariants and a repository-wide
//               scan for certificate-validation bypass patterns.
//
// Usage: node tests/security/run-security-checks.cjs   (root script:
//        npm run test:security)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');

const failures = [];
let checks = 0;

function check(description, fn) {
  checks++;
  try {
    fn();
    console.log(`  PASS  ${description}`);
  } catch (err) {
    failures.push(`${description}: ${err.message}`);
    console.log(`  FAIL  ${description} — ${err.message}`);
  }
}

async function checkAsync(description, fn) {
  checks++;
  try {
    await fn();
    console.log(`  PASS  ${description}`);
  } catch (err) {
    failures.push(`${description}: ${err.message}`);
    console.log(`  FAIL  ${description} — ${err.message}`);
  }
}

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// --- Finding A: dashboard security headers --------------------------------

async function dashboardHeaderChecks() {
  console.log('\nFinding A — dashboard security headers');

  const apps = [
    {
      name: 'admin_dashboard',
      cspMustInclude: "script-src 'self'",
      cspMustNotInclude: 'https://js.stripe.com',
    },
    {
      name: 'sponsor_portal',
      cspMustInclude: 'https://js.stripe.com',
      cspMustNotInclude: 'never-match',
    },
  ];

  for (const app of apps) {
    const serverPath = path.join(ROOT, 'apps', app.name, 'server.js');
    const mod = await import(pathToFileURL(serverPath).href);

    await checkAsync(`${app.name}: exports a testable createApp`, async () => {
      assert.equal(typeof mod.createApp, 'function');
    });
    check(`${app.name}: x-powered-by is disabled`, () => {
      const src = read(`apps/${app.name}/server.js`);
      assert.match(src, /disable\('x-powered-by'\)/);
    });

    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), `netride-${app.name}-dist-`));
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>ok</title>');
    const { server, port } = await listen(mod.createApp({ distDir }));
    try {
      await checkAsync(`${app.name}: CSP + baseline headers on the SPA shell`, async () => {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('x-frame-options'), 'DENY');
        assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
        const csp = res.headers.get('content-security-policy') ?? '';
        assert.ok(csp.includes(app.cspMustInclude), `CSP missing ${app.cspMustInclude}`);
        assert.ok(csp.includes("frame-ancestors 'none'"));
        assert.ok(!csp.includes(app.cspMustNotInclude), 'CSP must not include unexpected origin');
      });

      await checkAsync(`${app.name}: headers on 404 responses`, async () => {
        const res = await fetch(`http://127.0.0.1:${port}/assets/missing.js`);
        assert.equal(res.status, 404);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        // Express's finalhandler stamps its own locked-down
        // `default-src 'none'` on unhandled 404s; the app policy is
        // `default-src 'self'`. Either way a CSP must be present.
        const csp = res.headers.get('content-security-policy') ?? '';
        assert.ok(
          csp.includes("default-src 'self'") || csp.includes("default-src 'none'"),
          `unexpected 404 CSP: ${csp}`,
        );
      });

      await checkAsync(`${app.name}: HSTS only for TLS requests`, async () => {
        const plain = await fetch(`http://127.0.0.1:${port}/`);
        assert.equal(plain.headers.get('strict-transport-security'), null);
        const tls = await fetch(`http://127.0.0.1:${port}/`, {
          headers: { 'x-forwarded-proto': 'https' },
        });
        assert.equal(tls.headers.get('strict-transport-security'), 'max-age=15552000');
      });
    } finally {
      await close(server);
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }
}

// --- Finding D: mobile TLS configuration ----------------------------------

const MOBILE_APPS = ['driver_flutter', 'rider_flutter'];

function mobileConfigChecks() {
  console.log('\nFinding D — mobile TLS configuration');

  for (const app of MOBILE_APPS) {
    const mainManifest = read(`apps/${app}/android/app/src/main/AndroidManifest.xml`);
    const debugManifest = read(`apps/${app}/android/app/src/debug/AndroidManifest.xml`);
    const profileManifest = read(`apps/${app}/android/app/src/profile/AndroidManifest.xml`);
    const plist = read(`apps/${app}/ios/Runner/Info.plist`);

    check(`${app}: release manifest disables cleartext + backup`, () => {
      assert.match(mainManifest, /android:usesCleartextTraffic="false"/);
      assert.match(mainManifest, /android:allowBackup="false"/);
      assert.ok(!/android:usesCleartextTraffic="true"/.test(mainManifest));
      assert.ok(!/android:debuggable="true"/.test(mainManifest));
    });

    check(`${app}: cleartext is a debug-only, explicitly merged override`, () => {
      assert.match(debugManifest, /android:usesCleartextTraffic="true"/);
      assert.match(debugManifest, /tools:replace="android:usesCleartextTraffic"/);
      assert.ok(!/usesCleartextTraffic/.test(profileManifest));
    });

    check(`${app}: ATS has no arbitrary-loads exception`, () => {
      assert.ok(!/NSAllowsArbitraryLoads/.test(plist));
      assert.match(plist, /NSAllowsLocalNetworking/);
      assert.ok(!/NSExceptionAllowsInsecureHTTPLoads/.test(plist));
      assert.ok(!/NSExceptionDomains/.test(plist));
    });

    const webview = read(`apps/${app}/lib/screens/profile_screen.dart`);
    if (app === 'driver_flutter') {
      check(`${app}: payout WebView restricts navigation to Stripe`, () => {
        assert.match(webview, /onNavigationRequest/);
        assert.match(webview, /stripe\.com/);
        assert.match(webview, /NavigationDecision\.prevent/);
      });
    }
  }
}

const TLS_BYPASS_PATTERNS = [
  /badCertificateCallback/,
  /onBadCertificate/,
  /HttpOverrides\.global/,
  /X509TrustManager/,
  /HostnameVerifier/,
  /checkServerTrusted/,
  /setSSLSocketFactory/,
  /allowInsecure/,
  /serverTrust/,
  /NSAllowsArbitraryLoads/,
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['build', '.dart_tool', 'Pods', '.gradle'].includes(entry.name)) continue;
      walk(full, out);
    } else if (/\.(dart|kt|java|swift|m|mm)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function tlsBypassScan() {
  console.log('\nFinding D — TLS bypass source scan');

  const sourceRoots = [];
  for (const app of MOBILE_APPS) {
    sourceRoots.push(
      path.join(ROOT, 'apps', app, 'lib'),
      path.join(ROOT, 'apps', app, 'android', 'app', 'src'),
      path.join(ROOT, 'apps', app, 'ios', 'Runner'),
    );
  }

  const offenders = [];
  for (const root of sourceRoots) {
    for (const file of walk(root)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pattern of TLS_BYPASS_PATTERNS) {
        if (pattern.test(content)) {
          offenders.push(`${path.relative(ROOT, file)} matched ${pattern}`);
        }
      }
    }
  }

  check('no certificate-validation bypass in mobile source', () => {
    assert.deepEqual(offenders, []);
  });
}

// --- main ------------------------------------------------------------------

(async () => {
  console.log('NetRide security regression checks');
  await dashboardHeaderChecks();
  mobileConfigChecks();
  tlsBypassScan();

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.error('\nFAILURES:');
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error('security check runner crashed:', err);
  process.exit(1);
});
