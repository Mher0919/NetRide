// tests/security/database-security-checks.cjs
//
// Read-only, repeatable verification of NetRide's database authorization
// boundary. Run after the migrations in backend/migrations (the root
// `npm run test:security` includes this script when a database URL is
// available):
//
//   node tests/security/database-security-checks.cjs
//
// It uses backend/.env (DIRECT_DATABASE_URL || DATABASE_URL) and never writes
// to the database. Exit codes: 0 = all critical checks pass, 1 = regression.

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKEND = path.join(ROOT, 'backend');

require(path.join(BACKEND, 'node_modules', 'dotenv')).config({
  path: path.join(BACKEND, '.env'),
});

const connectionString = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.log('database-security-checks: no DATABASE_URL/DIRECT_DATABASE_URL; skipping');
  process.exit(0);
}

const { Client } = require(path.join(BACKEND, 'node_modules', 'pg'));

const failures = [];
const warnings = [];
let checks = 0;

function check(name, ok, detail = '') {
  checks++;
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

function warn(name, detail) {
  warnings.push(`${name}: ${detail}`);
  console.log(`  WARN  ${name} - ${detail}`);
}

async function roleExists(c, role) {
  const r = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  return r.rowCount > 0;
}

async function deniedAs(c, role, sql) {
  await c.query('BEGIN READ ONLY');
  try {
    await c.query(`SET LOCAL ROLE ${role}`);
    await c.query(sql);
    return { denied: false };
  } catch (err) {
    return { denied: err.code === '42501', code: err.code, message: err.message.split('\n')[0] };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
  }
}

(async () => {
  const c = new Client({ connectionString });
  await c.connect();
  console.log('NetRide database authorization checks');

  const anon = await roleExists(c, 'anon');
  const authenticated = await roleExists(c, 'authenticated');

  // ---- public schema ------------------------------------------------------
  if (anon) {
    const r = await c.query("SELECT has_schema_privilege('anon','public','USAGE') u");
    check('anon has no USAGE on public schema', r.rows[0].u === false);
    const d = await deniedAs(c, 'anon', 'SELECT count(*) FROM public.users');
    check('anon cannot select public.users', d.denied, d.code || d.message || 'unexpected success');
  }
  if (authenticated) {
    const r = await c.query("SELECT has_schema_privilege('authenticated','public','USAGE') u");
    check('authenticated has no USAGE on public schema', r.rows[0].u === false);
    const d = await deniedAs(c, 'authenticated', 'SELECT count(*) FROM public.users');
    check('authenticated cannot select public.users', d.denied, d.code || d.message || 'unexpected success');
  }

  const grants = await c.query(`
    SELECT c.relname, x.grantee::regrole::text AS grantee, x.privilege_type
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r','p','v','m','S')
       AND x.grantee <> c.relowner
       AND x.grantee <> 0
       AND x.grantee::regrole::text IN ('anon','authenticated')
  `);
  check('no anon/authenticated table/sequence grants in public', grants.rowCount === 0,
    grants.rows.map((r) => `${r.relname}:${r.grantee}:${r.privilege_type}`).join(', '));

  // ---- RLS coverage -------------------------------------------------------
  const noRls = await c.query(`
    SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r','p')
       AND c.relrowsecurity = false
  `);
  const unexpected = noRls.rows.filter((r) => r.relname !== 'spatial_ref_sys');
  check('every application table has RLS enabled', unexpected.length === 0,
    unexpected.map((r) => r.relname).join(', '));
  const spatial = noRls.rows.find((r) => r.relname === 'spatial_ref_sys');
  check('spatial_ref_sys remains the documented extension-owned exception', !!spatial);

  const policies = await c.query("SELECT count(*)::int n FROM pg_policies WHERE schemaname = 'public'");
  check('no direct-client policies remain in public', policies.rows[0].n === 0,
    `${policies.rows[0].n} policies found`);

  const appFns = await c.query(`
    SELECT p.oid::regprocedure::text AS fn,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('cleanup_route_caches','region_contains','search_places','migrate_file_url')
  `);
  check('app helper functions are not executable by anon/authenticated',
    appFns.rows.every((r) => r.anon_exec === false && r.auth_exec === false),
    appFns.rows.filter((r) => r.anon_exec || r.auth_exec).map((r) => r.fn).join(', '));

  const appRelease = await c.query(`
    SELECT c.relrowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'app_release_configs'
  `);
  if (appRelease.rowCount > 0) {
    check('app_release_configs has RLS enabled', appRelease.rows[0].relrowsecurity === true);
  }

  const ledger = await c.query(`
    SELECT c.reloptions
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'reward_ledger'
  `);
  if (ledger.rowCount > 0) {
    check('reward_ledger is security_invoker', (ledger.rows[0].reloptions || []).includes('security_invoker=true'));
  }

  // ---- spatial_ref_sys exception -----------------------------------------
  const spatialPrivs = await c.query(`
    SELECT
      COALESCE(bool_or(x.privilege_type = 'SELECT'), false) AS public_select,
      COALESCE(bool_or(x.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')), false) AS public_write
      FROM pg_class c
      CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.oid = 'public.spatial_ref_sys'::regclass
       AND x.grantee = 0
  `).catch(() => ({ rows: [{}] }));
  if (spatialPrivs.rows[0]?.public_select !== undefined) {
    check('spatial_ref_sys PUBLIC can read reference metadata', spatialPrivs.rows[0].public_select === true);
    check('spatial_ref_sys PUBLIC cannot write', spatialPrivs.rows[0].public_write === false);
  }
  if (anon) {
    const d = await deniedAs(c, 'anon', 'SELECT count(*) FROM public.spatial_ref_sys');
    check('anon cannot reach spatial_ref_sys through the Data API', d.denied, d.code || 'unexpected success');
  }

  // ---- storage ------------------------------------------------------------
  const storageExists = await c.query("SELECT to_regnamespace('storage') IS NOT NULL AS ok");
  if (storageExists.rows[0].ok) {
    // storage.objects is owned by supabase_storage_admin. The postgres
    // migration role cannot revoke grants granted by that owner (only the
    // owner/superuser can), so effective access is enforced by RLS: every
    // anon/authenticated policy is removed and RLS is enabled. Verify the
    // effective result (zero visible rows), and surface the remaining grant
    // hygiene task as a warning for a Supabase-owner follow-up.
    for (const role of ['anon', 'authenticated'].filter((r) => (r === 'anon' ? anon : authenticated))) {
      const r = await c.query(`SELECT has_schema_privilege('${role}','storage','USAGE') u`);
      if (r.rows[0].u === true) {
        warn(`${role} still has storage schema USAGE`,
          'grants are owned by supabase_storage_admin; RLS deny-all is the effective control - revoke via the Supabase owner/dashboard');
      } else {
        check(`${role} has no USAGE on storage schema`, true);
      }
      await c.query('BEGIN READ ONLY');
      let rows;
      try {
        await c.query(`SET LOCAL ROLE ${role}`);
        const q = await c.query("SELECT count(*)::int n FROM storage.objects WHERE bucket_id = 'uploads'");
        rows = { ok: true, n: q.rows[0].n };
      } catch (e) {
        rows = { ok: false, code: e.code, n: null };
      } finally {
        await c.query('ROLLBACK').catch(() => {});
      }
      if (rows.ok) {
        check(`${role} sees zero storage.objects rows`, rows.n === 0, `${rows.n} visible`);
      } else {
        check(`${role} is denied storage.objects access`, rows.code === '42501', rows.code || 'unexpected');
      }
    }

    const storageGrants = await c.query(`
      SELECT c.relname, x.grantee::regrole::text AS grantee, x.privilege_type
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(c.relacl) x
       WHERE n.nspname = 'storage'
         AND c.relkind IN ('r','p','v','m','S')
         AND x.grantee <> c.relowner
         AND x.grantee <> 0
         AND x.grantee::regrole::text IN ('anon','authenticated')
    `);
    if (storageGrants.rowCount === 0) {
      check('no anon/authenticated grants on storage objects', true);
    } else {
      warn('storage grants remain on anon/authenticated',
        `${storageGrants.rowCount} grant(s) owned by supabase_storage_admin; RLS policies are removed so effective access is denied`);
    }

    const storagePolicies = await c.query(`
      SELECT tablename, policyname, roles
        FROM pg_policies
       WHERE schemaname = 'storage'
         AND roles && ARRAY['anon','authenticated','public']::name[]
    `);
    check('no anon/authenticated/PUBLIC storage policies', storagePolicies.rowCount === 0,
      storagePolicies.rows.map((r) => `${r.tablename}:${r.policyname}`).join(', '));

    const buckets = await c.query("SELECT id, public FROM storage.buckets WHERE id IN ('uploads','secure-documents')");
    const uploads = buckets.rows.find((b) => b.id === 'uploads');
    if (!uploads) {
      check('uploads bucket exists', false);
    } else if (uploads.public === true) {
      warn('uploads bucket is still public',
        'deploy the signed-URL backend, then run 20261028_private_uploads_bucket.sql');
    } else {
      check('uploads bucket is private', uploads.public === false);
    }
    const secure = buckets.rows.find((b) => b.id === 'secure-documents');
    if (secure) check('secure-documents bucket is private', secure.public === false);

    const legacyPrivate = await c.query(`
      SELECT count(*)::int n FROM public.storage_files
       WHERE bucket = 'supabase' AND visibility <> 'public' AND storage_bucket = 'uploads'
    `).catch(() => ({ rows: [{ n: 0 }] }));
    if (legacyPrivate.rows[0].n > 0) {
      warn('legacy private files still in uploads bucket',
        `${legacyPrivate.rows[0].n} row(s); run scripts/migrate-storage-visibility.cjs`);
    }
  }

  await c.end();

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (warnings.length) {
    console.log('Warnings (deployment follow-up):');
    for (const w of warnings) console.log(` - ${w}`);
  }
  if (failures.length) {
    console.error('\nFAILURES:');
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error('database-security-checks crashed:', err.message);
  process.exit(1);
});
