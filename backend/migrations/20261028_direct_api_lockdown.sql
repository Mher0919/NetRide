-- 20261028_direct_api_lockdown.sql
--
-- NetRide uses its own JWT/session model and talks to PostgreSQL through the
-- trusted backend connection. No client (Rider/Driver app, admin dashboard,
-- sponsor portal, or Supabase Storage browser SDK) queries the public schema
-- directly. The Supabase anon key is nevertheless shipped inside both Flutter
-- apps, so the Data API / Storage API surface must be deny-by-default.
--
-- This migration intentionally does NOT enable RLS blindly on every object.
-- Base tables remain RLS-enabled (migration 016/057) with no direct-client
-- policies, and the trusted backend retains its owner connection. The two
-- extension-owned objects are treated differently:
--
--   * spatial_ref_sys is PostGIS-owned EPSG reference data. It is deliberately
--     left without RLS: it is static, non-sensitive, extension-managed and
--     read-only to PUBLIC. FORCE RLS or a rewrite would risk ST_Transform /
--     spatial-reference behaviour and extension upgrades. The public schema
--     is not reachable by anon/authenticated, so the PUBLIC SELECT grant does
--     not create an API exposure.
--   * geography_columns / geometry_columns are PostGIS metadata views,
--     read-only and extension-owned.
--
-- The actual exposure fixed here was Supabase Storage: anon/authenticated held
-- SELECT/INSERT/UPDATE/DELETE on storage.objects and eight permissive policies
-- (bucket_id = 'uploads'), allowing anyone with the client-shipped anon key to
-- list, upload, overwrite and delete objects. All direct client storage access
-- is removed. The backend continues to use the service-role key server-side.

-- ---------------------------------------------------------------------------
-- 1. Public schema: no direct Data API access for anon/authenticated.
--    (RLS remains enabled on application tables; grants are the first gate.)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  -- A freshly-created database inherits PUBLIC USAGE on the public schema;
  -- production has already revoked it. Codify deny-by-default in both cases.
  EXECUTE 'REVOKE ALL ON SCHEMA public FROM PUBLIC';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA public FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM authenticated';
  END IF;
END $$;

-- Future objects created by the migration owner must not silently inherit
-- Data API grants.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated';
  END IF;
END $$;

-- The policies from migrations 016/020/024/025 assume Supabase Auth
-- (auth.uid()) and a direct PostgREST client. NetRide has neither: its JWTs
-- are issued by the backend and users.id is not a Supabase Auth UID. Keeping
-- them is misleading and, if a grant were ever restored, the users/drivers
-- UPDATE policies would allow self-service role/verification escalation (RLS
-- does not restrict columns). Direct-client access is intentionally disabled,
-- so remove every public-schema policy and leave RLS as a deny-all backstop.
DO $$
DECLARE
  p RECORD;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
                   p.policyname, p.schemaname, p.tablename);
  END LOOP;
END $$;

-- app_release_configs was the only application table without RLS. It is
-- read/written exclusively by the backend (owner connection) and must be
-- deny-by-default for every non-owner role.
ALTER TABLE IF EXISTS public.app_release_configs ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. Application helper functions: not callable by PUBLIC.
--    The backend owner can still execute them (owner privileges).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.cleanup_route_caches()',
    'public.region_contains(double precision,double precision,double precision,double precision,double precision)',
    'public.search_places(text,double precision,double precision,integer)',
    'public.migrate_file_url(text,uuid,text)'
  ]
  LOOP
    IF to_regprocedure(fn) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
      END IF;
    END IF;
  END LOOP;
END $$;

-- Re-assert invoker semantics for the ledger view (PG15+). The backend is the
-- only consumer; without security_invoker the view would run as its owner and
-- bypass base-table RLS.
DO $$
BEGIN
  IF to_regclass('public.reward_ledger') IS NOT NULL THEN
    BEGIN
      EXECUTE 'ALTER VIEW public.reward_ledger SET (security_invoker = true)';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Supabase Storage: remove all direct client access.
--    The backend uses SUPABASE_SERVICE_ROLE_KEY server-side for upload,
--    signing and deletion. Public bucket URLs and the anon key are not an
--    authorization boundary.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regnamespace('storage') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON SCHEMA storage FROM PUBLIC';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA storage FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA storage FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA storage FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA storage FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA storage FROM authenticated';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA storage FROM authenticated';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA storage FROM authenticated';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA storage FROM authenticated';
  END IF;
END $$;

-- Drop every storage policy that grants anon/authenticated/PUBLIC anything.
-- service_role bypasses RLS and is unaffected; no client uses Storage directly.
DO $$
DECLARE
  p RECORD;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, roles
      FROM pg_policies
     WHERE schemaname = 'storage'
       AND tablename IN ('objects', 'buckets')
  LOOP
    IF p.roles && ARRAY['anon', 'authenticated', 'public']::name[] THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
                     p.policyname, p.schemaname, p.tablename);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. PostGIS extension-owned reference objects: document the exception.
--    No structural change is made. spatial_ref_sys has PUBLIC SELECT only,
--    is owned by supabase_admin, contains 8,500 static EPSG rows and is never
--    written by the application. RLS is intentionally left disabled.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  -- Defence in depth only: if any non-SELECT grant was ever added to PUBLIC,
  -- remove it. Do not touch the table's structure, owner or RLS state.
  BEGIN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON public.spatial_ref_sys FROM PUBLIC';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;
