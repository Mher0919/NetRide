-- backend/migrations/045_regions.sql
--
-- REGIONS (geofence-based market segmentation for analytics)
-- ---------------------------------------------------------------------------
-- A region is a named geofence (center + radius). Rides are attributed to
-- a region at QUERY time by pickup-point proximity to the region center
-- (haversine distance <= radius_km) — no ride-row writes are required and
-- ride attribution stays consistent with the canonical ride source.
--
-- Only admins create regions; all timestamps UTC.

CREATE TABLE IF NOT EXISTS regions (
  code         TEXT        PRIMARY KEY,
  name         TEXT        NOT NULL,
  country_code TEXT        NOT NULL DEFAULT 'US',
  center_lat   DOUBLE PRECISION NOT NULL
                 CHECK (center_lat >= -90 AND center_lat <= 90),
  center_lng   DOUBLE PRECISION NOT NULL
                 CHECK (center_lng >= -180 AND center_lng <= 180),
  radius_km    DOUBLE PRECISION NOT NULL DEFAULT 25
                 CHECK (radius_km > 0 AND radius_km <= 500),
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_regions_active ON regions (is_active);

-- Haversine distance (meters) between two lat/lng points — used by the
-- analytics region filter (pickup point inside the region circle).
CREATE OR REPLACE FUNCTION region_contains(
  p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION,
  c_lat DOUBLE PRECISION, c_lng DOUBLE PRECISION,
  radius_km DOUBLE PRECISION
) RETURNS BOOLEAN AS $$
DECLARE
  dlat DOUBLE PRECISION;
  dlng DOUBLE PRECISION;
  a DOUBLE PRECISION;
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL OR c_lat IS NULL OR c_lng IS NULL THEN
    RETURN FALSE;
  END IF;
  dlat := radians(c_lat - p_lat);
  dlng := radians(c_lng - p_lng);
  a := sin(dlat / 2) ^ 2
     + cos(radians(p_lat)) * cos(radians(c_lat)) * sin(dlng / 2) ^ 2;
  RETURN 2 * 6371000 * asin(sqrt(a)) <= radius_km * 1000;
END;
$$ LANGUAGE plpgsql IMMUTABLE;