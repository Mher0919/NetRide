// backend/scripts/run-e2e-cancellation.cjs
// Hardened harness wrapper:
//   1. Marks any lingering REQUESTED rides CANCELLED so the matcher has
//      nothing it can latch on between runs.
//   2. Symmetrically resets the two test drivers so scoring is identical
//      (deterministic first-offer attribution in both A and B paths).
//   3. Clears Redis offer/lock residue.
//   4. Restarts the backend so any in-process matchers from the previous
//      run are killed (their state can otherwise survive and re-offer the
//      same driver while our new exclusion is being committed).
//   5. Waits for the new backend to be reachable on :3000.
//   6. Runs the existing e2e harness.

require('dotenv').config();
const { Client } = require('pg');
const Redis = require('ioredis');
const { spawn, execSync } = require('child_process');
const path = require('path');

const BACKEND_PORT = Number(process.env.PORT || 3000);
const BACKEND_DIR = __dirname;
const LOG_DIR = 'C:/Users/mmkrt/AppData/Local/Temp/opencode';
const BACKEND_OUT = path.join(LOG_DIR, 'backend-e2e-harness.log');
const BACKEND_ERR = path.join(LOG_DIR, 'backend-e2e-harness.err');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function db() {
  const c = new Client({ connectionString: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL });
  await c.connect();
  return c;
}

async function resetDrives() {
  const c = await db();
  // Wipe any rides stuck in REQUESTED — these can re-feed matchers across runs.
  await c.query(`
    UPDATE rides
       SET status = 'CANCELLED',
           cancelled_at = NOW(),
           cancellation_reason_text = COALESCE(cancellation_reason_text, '') || 'harness cleanup',
           cancelled_by = NULL
     WHERE status = 'REQUESTED'
  `);
  // Symmetric driver scoring: equal cancellation_count, no recent cancel,
  // equal rating; the matcher then picks by tie-breakers (favorite, ID order)
  // and the test deliberately accepts whichever offer arrives first.
  await c.query(`
    UPDATE drivers
       SET cancellation_count = 0,
           last_cancellation_at = NULL,
           rating = 5.0,
           total_rides = 1000
     WHERE user_id IN ('5c874b6b-d4f8-43c2-951d-62a29ec3240b',
                        '2427233a-c353-4da1-8106-78127302425f')
  `);
  // Clear demo drivers' transient state that the dispatch engine reads.
  await c.query(`
    UPDATE drivers
       SET acceptance_count = 1000, is_dangerous = FALSE, is_flagged = FALSE
     WHERE user_id IN ('5c874b6b-d4f8-43c2-951d-62a29ec3240b',
                        '2427233a-c353-4da1-8106-78127302425f')
  `);
  console.log('[resetDrives] cancel-staged REQUESTED rides, driver scoring reset');
  await c.end();
}

async function clearRedis() {
  const r = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  const keys = [
    ...await r.keys('driver:offer:*'),
    ...await r.keys('ride:offer:*'),
    ...await r.keys('ride:lock:*'),
    ...await r.keys('dispatch:winners:*'),
    ...await r.keys('driver:heartbeat:*'),
  ];
  if (keys.length > 0) await r.del(...keys);
  console.log(`[clearRedis] removed ${keys.length} residue keys`);
  await r.quit();
}

function killExistingBackend() {
  // Stop ONLY the backend's ts-node child by PID lookup of anything listening
  // on the backend port. Do NOT touch Flutter sandbox processes or unrelated
  // node work.
  try {
    const pids = execSync(`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${BACKEND_PORT} -State Listen).OwningProcess"`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim().split(/\s+/).filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGTERM');
        console.log(`[killExistingBackend] sent SIGTERM to PID ${pid}`);
      } catch {}
    }
  } catch {}
}

function startBackend() {
  // Background ts-node; output redirected so the run log is the one place to look.
  const args = [
    'node_modules/ts-node/dist/bin.js', 'src/app.ts',
  ];
  const env = { ...process.env };
  const child = spawn(process.execPath, args, {
    cwd: BACKEND_DIR,
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // Detach: process becomes its own session so it outlives this harness.
  child.stdout.on('data', (b) => {
    require('fs').appendFileSync(BACKEND_OUT, b);
  });
  child.stderr.on('data', (b) => {
    require('fs').appendFileSync(BACKEND_ERR, b);
  });
  child.unref();
  return child.pid;
}

async function waitBackendReady() {
  const start = Date.now();
  while (Date.now() - start < 45000) {
    try {
      const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/health/live`);
      if (res.status === 200) {
        // Settle: heat up the connection pool + Redis lazyConnect so the first
        // test's ride request doesn't pay the cold-start tax.
        await sleep(2000);
        console.log(`[waitBackendReady] ready in ${Date.now() - start}ms`);
        return;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('backend did not become ready within 45s');
}

async function main() {
  const runs = Number(process.argv[2] || 1);
  const {
    spawn: cpSpawn,
  } = require('child_process');

  await killExistingBackend();
  await sleep(1500); // give the previous backend time to release the socket
  await resetDrives();
  await clearRedis();
  const pid = startBackend();
  console.log(`[startBackend] spawned PID ${pid}`);
  await waitBackendReady();

  let aggregate = { passed: 0, failed: 0 };
  for (let i = 0; i < runs; i++) {
    console.log(`\n══════ E2E RUN ${i + 1}/${runs} ══════`);
    if (i > 0) {
      // Full process restart between runs so matchers from the previous
      // run cannot race the new run; cleanup is symmetric across Redis
      // and the DB ride/drivers state.
      killExistingBackend();
      await sleep(1500);
      await resetDrives();
      await clearRedis();
      const pid = startBackend();
      console.log(`[startBackend] spawned PID ${pid}`);
      await waitBackendReady();
    } else {
      await resetDrives();
      await clearRedis();
      await sleep(1500);
    }
    const exitCode = await new Promise((resolve) => {
      const child = cpSpawn(process.execPath, ['e2e-cancellation.cjs'], {
        cwd: BACKEND_DIR,
        stdio: 'inherit',
        env: process.env,
      });
      child.on('exit', (code) => resolve(code ?? 1));
    });
    if (exitCode === 0) aggregate.passed++;
    else aggregate.failed++;
  }

  console.log(`\n══════ AGGREGATE: ${aggregate.passed}/${runs} passed ══════`);
  process.exit(aggregate.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('harness failed:', e.message);
  process.exit(2);
});
