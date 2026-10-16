-- Migration 057: File-security classification + RLS hardening
--
-- Root cause addressed: every uploaded file (public profile photos AND
-- government ID / driver-license / insurance / registration documents) was
-- stored in ONE public Supabase Storage bucket and referenced by an
-- unauthenticated `GET /api/files/{id}` endpoint. File UUIDs are not an
-- authorization mechanism.
--
-- This migration:
--   1. Adds an explicit `visibility` classification to `storage_files`
--      (public = intentionally public profile photos; private = everything
--      else, including all verification documents).
--   2. Adds `storage_bucket` so private objects can live in a dedicated
--      private bucket (`secure-documents`) while public profile photos stay
--      in the public `uploads` bucket.
--   3. Backfills the classification from the legacy URL columns migration
--      (029) stamped into `original_name`.
--   4. Enables deny-by-default RLS on every sensitive table that had no RLS,
--      and revokes `anon`/`authenticated` grants on those tables. The Node
--      backend connects with the database owner / service role which bypasses
--      RLS, so application behaviour is unchanged while direct PostgREST
--      access from a leaked anon key is denied.
--
-- Operational follow-up (documented in the security report):
--   * The `secure-documents` bucket is created private on first use by
--     backend/src/config/supabase.ts (`ensurePrivateBucket`). After running
--     `backend/scripts/migrate-storage-visibility.cjs` to copy private
--     objects into it and delete their public copies, leaving `uploads`
--     public is safe because only profile photos remain there.

-- ---------------------------------------------------------------------------
-- 1. storage_files classification
-- ---------------------------------------------------------------------------

ALTER TABLE storage_files
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';

ALTER TABLE storage_files
  ADD COLUMN IF NOT EXISTS storage_bucket TEXT NOT NULL DEFAULT 'uploads';

-- Constrain values (idempotent: drop-if-exists then add).
ALTER TABLE storage_files DROP CONSTRAINT IF EXISTS storage_files_visibility_check;
ALTER TABLE storage_files
  ADD CONSTRAINT storage_files_visibility_check
  CHECK (visibility IN ('public', 'private'));

-- Backfill: ONLY intentionally public profile photos are public. Anything
-- else (IDs, licenses, insurance, registration, inspection, face enrollment,
-- unknown) stays/becomes private — secure by default.
--
-- (a) Exact reference backfill: any storage file actually referenced by a
--     public profile/logo column is public by definition. This covers legacy
--     uploads made through the generic /api/upload endpoint that used the
--     `general` path segment.
UPDATE storage_files sf
   SET visibility = 'public'
 WHERE visibility <> 'public'
   AND (
        EXISTS (SELECT 1 FROM users u WHERE u.profile_image_url = '/api/files/' || sf.id)
     OR EXISTS (SELECT 1 FROM sponsors s WHERE s.logo_url = '/api/files/' || sf.id
                                              OR s.cover_image_url = '/api/files/' || sf.id)
   );

-- (b) Path/name heuristic for anything not currently referenced (e.g. a
--     freshly uploaded headshot whose profile row has not been written yet).
UPDATE storage_files
   SET visibility = 'public'
 WHERE visibility <> 'public'
   AND (
        path LIKE '%/profile/%'
     OR path LIKE '%/avatar/%'
     OR original_name IN ('profile_image_url', 'avatar', 'header')
   );

CREATE INDEX IF NOT EXISTS idx_storage_files_visibility
  ON storage_files (visibility);

-- ---------------------------------------------------------------------------
-- 2. Deny-by-default RLS on sensitive tables that had no RLS at all
--    (migration 016 only covered 10 tables). No policies are created: the
--    backend uses an RLS-bypassing role, anonymous/authenticated PostgREST
--    access is denied.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t TEXT;
  sensitive_tables TEXT[] := ARRAY[
    'storage_files',
    'driver_vehicle_resubmission_requests',
    'speeding_violations',
    'ride_reports',
    'ride_messages',
    'ride_driver_rejections',
    'device_tokens',
    'user_devices',
    'notifications',
    'rider_activity',
    'rider_wallets',
    'wallet_transactions',
    'ride_credit_accounts',
    'credit_transactions',
    'financial_transactions',
    'stripe_payments',
    'stripe_webhook_events',
    'ride_fare_breakdowns',
    'stripe_customers',
    'driver_stripe_accounts',
    'sponsor_withdrawals',
    'sponsors',
    'sponsor_portal_accounts',
    'sponsor_ledger_entries',
    'special_redemptions',
    'partners',
    'fleet_partners',
    'fleet_portal_accounts',
    'promo_codes',
    'promo_usage',
    'partner_commissions',
    'referral_codes',
    'referral_relationships',
    'referral_rewards',
    'audit_events',
    'pricing_profiles',
    'pricing_configurations',
    'ride_price_snapshots',
    'revenue_configs',
    'driver_ride_preferences',
    'regions',
    'route_cache',
    'eta_cache',
    'cache_config',
    'ride_routes',
    'migrations_applied',
    'places'
  ];
BEGIN
  FOREACH t IN ARRAY sensitive_tables LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;

-- The reward_ledger view projects wallet/credit ledgers. Without
-- security_invoker it executes with the owner's rights and would bypass the
-- RLS enabled above for PostgREST callers. PG15+ supports this option.
DO $$
BEGIN
  IF to_regclass('public.reward_ledger') IS NOT NULL THEN
    BEGIN
      EXECUTE 'ALTER VIEW public.reward_ledger SET (security_invoker = true)';
    EXCEPTION WHEN others THEN
      -- Pre-15 server: fall back to revoking public access to the view.
      EXECUTE 'REVOKE ALL ON public.reward_ledger FROM PUBLIC';
    END;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Defence in depth: revoke anon/authenticated table grants. RLS alone
--    already denies, but removing the grants means a future policy mistake
--    cannot re-open the tables to the leaked anon key.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t TEXT;
  r TEXT;
  protected_tables TEXT[] := ARRAY[
    'storage_files','driver_vehicle_resubmission_requests','speeding_violations',
    'ride_reports','ride_messages','ride_driver_rejections','device_tokens',
    'user_devices','notifications','rider_activity','rider_wallets',
    'wallet_transactions','ride_credit_accounts','credit_transactions',
    'financial_transactions','stripe_payments','stripe_webhook_events',
    'ride_fare_breakdowns','stripe_customers','driver_stripe_accounts',
    'sponsor_withdrawals','sponsors','sponsor_portal_accounts',
    'sponsor_ledger_entries','special_redemptions','partners','fleet_partners',
    'fleet_portal_accounts','promo_codes','promo_usage','partner_commissions',
    'referral_codes','referral_relationships','referral_rewards','audit_events',
    'pricing_profiles','pricing_configurations','ride_price_snapshots',
    'revenue_configs','driver_ride_preferences','verification_codes',
    'audit_logs','driver_wallets','payouts','payout_cards'
  ];
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY protected_tables LOOP
        IF to_regclass('public.' || t) IS NOT NULL THEN
          EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I', t, r);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- Also revoke EXECUTE on legacy helper functions reachable over RPC that
-- bypass caller intent when invoked anonymously.
DO $$
BEGIN
  IF to_regclass('public.migrate_file_url') IS NOT NULL THEN
    BEGIN
      EXECUTE 'REVOKE ALL ON FUNCTION public.migrate_file_url(text, uuid, text) FROM PUBLIC';
    EXCEPTION WHEN others THEN NULL;
    END;
  END IF;
END $$;
