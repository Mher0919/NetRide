-- 20261016_sponsor_profile_and_test_markers.sql
--
-- 1) Manual business-profile fields for the Sponsor "Add Manually" workflow:
--    admin-entered rating + star value, rating count, price level and a
--    gallery of uploaded business photos. The logo continues to live in
--    `logo_url`, and gallery photos are ordered `/api/files/:id` references.
--
--    The `admin_rating` column is deliberately SEPARATE from Google-sourced
--    data (sponsors.google_business_*): an administrator-entered rating must
--    never be presented as a verified Google rating.
--
-- 2) Persistent test markers (`is_test`) for sponsors and partners. The
--    canonical email rule (backend/src/utils/testUser.ts) cannot classify
--    fixture rows that carry no email at all (e.g. payment-integration
--    sponsors created directly by tests). `is_test` is the explicit,
--    non-attacker-reachable marker those fixtures set, and the sponsor/
--    partner list predicates treat it as authoritative in ADDITION to the
--    email rule.
--
-- Historical classification: the payment/integration fixtures are the only
-- writers that ever set `business_type = 'TEST'` (the admin API validates
-- business types and rejects it), so rows with that value are reliably test
-- data. Rows without such evidence are NOT relabelled.

ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS admin_rating NUMERIC(2,1);
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS admin_rating_count INTEGER;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS price_level TEXT;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS photo_urls JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

-- Historical, evidence-backed backfill (fixture-only marker).
UPDATE sponsors SET is_test = TRUE WHERE business_type = 'TEST' AND is_test = FALSE;

DO $$ BEGIN
  ALTER TABLE sponsors ADD CONSTRAINT sponsors_admin_rating_range
    CHECK (admin_rating IS NULL OR (admin_rating >= 0 AND admin_rating <= 5));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE sponsors ADD CONSTRAINT sponsors_admin_rating_count_nonnegative
    CHECK (admin_rating_count IS NULL OR admin_rating_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE sponsors ADD CONSTRAINT sponsors_price_level_valid
    CHECK (price_level IS NULL OR price_level ~ '^\${1,4}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE sponsors ADD CONSTRAINT sponsors_photo_urls_array
    CHECK (jsonb_typeof(photo_urls) = 'array');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_sponsors_is_test ON sponsors (is_test);
CREATE INDEX IF NOT EXISTS idx_partners_is_test ON partners (is_test);
