-- backend/migrations/050_special_google_business.sql
--
-- GOOGLE BUSINESS ASSOCIATION for SPECIALS.
-- ---------------------------------------------------------------------------
-- The Google Place ID is the canonical external business identifier
-- (special.googlePlaceId equivalent). Every other column here is a minimal
-- cached identity used only for fallback display when Google is unreachable;
-- it is refreshed from Google whenever the special is opened/edited.
--
-- Google policy: Place IDs may be stored indefinitely; associated content
-- (name/address/coordinates/category) is cached with a sync timestamp and
-- refreshed well within Google's 30-day storage allowance. Reviews, hours
-- and photos are NEVER persisted — they are served from a short-lived
-- server-side cache only.
--
-- Safe to re-run (IF NOT EXISTS throughout).

ALTER TABLE sponsors
  ADD COLUMN IF NOT EXISTS google_place_id            TEXT,
  ADD COLUMN IF NOT EXISTS google_business_name       TEXT,
  ADD COLUMN IF NOT EXISTS google_business_category   TEXT,
  ADD COLUMN IF NOT EXISTS google_business_latitude   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS google_business_longitude  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS google_business_address    TEXT,
  ADD COLUMN IF NOT EXISTS google_places_synced_at    TIMESTAMPTZ;

-- Google-connected specials are filtered/scanned by Place ID.
CREATE INDEX IF NOT EXISTS sponsors_google_place_idx
  ON sponsors (google_place_id)
  WHERE google_place_id IS NOT NULL;
