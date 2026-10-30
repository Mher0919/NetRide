-- 20261028_private_uploads_bucket.sql
--
-- The `uploads` bucket was created public. It still contains driver licence /
-- registration / other verification images (migration 057's data move was an
-- operational follow-up and had not been run), and a public bucket serves
-- objects without consulting storage RLS. Even after the Storage API grants
-- are revoked in 20261028_direct_api_lockdown.sql, a guessed/leaked object
-- path remains publicly downloadable.
--
-- DEPLOYMENT ORDER (important):
--   1. Deploy the backend version that signs EVERY Supabase object (public and
--      private) through the service-role key. `StorageService.getAccessUrl`
--      in this tree does that. /api/files/:id continues to allow anonymous
--      access to visibility='public' rows, but the upstream fetch is signed.
--   2. Then run this migration. It flips the bucket to private and makes the
--      public object URLs fail closed.
--   3. Run `node scripts/migrate-storage-visibility.cjs` (with
--      SUPABASE_SERVICE_ROLE_KEY) to copy the nine legacy private objects into
--      `secure-documents`, repoint storage_files and delete the public copies.
--
-- Running this migration before step 1 makes profile photos unavailable
-- through /api/files until the new backend is live. It never re-exposes data.
--
-- Storage tables are owned by supabase_storage_admin. This migration only
-- updates the bucket configuration row; it does not alter extension-owned
-- table structure, policies or ownership.

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage.buckets not present; skipping bucket privacy change';
    RETURN;
  END IF;

  UPDATE storage.buckets
     SET public = false,
         updated_at = now()
   WHERE id = 'uploads'
     AND public IS DISTINCT FROM false;

  -- If a private bucket was created public by mistake, close it too.
  UPDATE storage.buckets
     SET public = false,
         updated_at = now()
   WHERE id = 'secure-documents'
     AND public IS DISTINCT FROM false;
END $$;
