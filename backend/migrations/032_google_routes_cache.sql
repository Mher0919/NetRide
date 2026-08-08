-- Migration 032: Google Routes API route cache table
-- Stores route results keyed by H3 hexagon indices for spatial reuse.
-- This reduces Google Routes API costs by serving nearby OD pairs
-- from the same cached result.

CREATE TABLE IF NOT EXISTS route_cache (
  id              BIGSERIAL PRIMARY KEY,
  origin_hex      VARCHAR(15) NOT NULL,   -- H3 origin cell at resolution 8 (~0.7km)
  dest_hex        VARCHAR(15) NOT NULL,   -- H3 destination cell
  origin_lat      DOUBLE PRECISION NOT NULL,
  origin_lng      DOUBLE PRECISION NOT NULL,
  dest_lat        DOUBLE PRECISION NOT NULL,
  dest_lng        DOUBLE PRECISION NOT NULL,
  distance_meters DOUBLE PRECISION NOT NULL,
  duration_seconds DOUBLE PRECISION NOT NULL,
  traffic_duration_seconds DOUBLE PRECISION,  -- NULL if static route
  polyline        TEXT NOT NULL,           -- Encoded polyline (Google format)
  steps           JSONB DEFAULT '[]'::jsonb,
  engine          VARCHAR(32) NOT NULL DEFAULT 'GoogleRoutes',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accessed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  access_count    INTEGER NOT NULL DEFAULT 1,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);

-- Composite index for exact OD pair lookups
CREATE INDEX IF NOT EXISTS idx_route_cache_od
  ON route_cache (origin_hex, dest_hex);

-- Index for expiry sweeps
CREATE INDEX IF NOT EXISTS idx_route_cache_expires
  ON route_cache (expires_at);

-- Index for popularity-based cache eviction
CREATE INDEX IF NOT EXISTS idx_route_cache_popularity
  ON route_cache (access_count DESC);

-- Table for ETA cache (short TTL, traffic-aware)
CREATE TABLE IF NOT EXISTS eta_cache (
  id              BIGSERIAL PRIMARY KEY,
  origin_hex      VARCHAR(15) NOT NULL,
  dest_hex        VARCHAR(15) NOT NULL,
  distance_meters DOUBLE PRECISION NOT NULL,
  duration_seconds DOUBLE PRECISION NOT NULL,
  traffic_duration_seconds DOUBLE PRECISION,
  is_traffic_aware BOOLEAN NOT NULL DEFAULT false,
  time_of_day     TIME,                    -- The time-of-day this ETA applies to
  day_of_week     SMALLINT,                -- 0=Sunday, 6=Saturday; NULL=any
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes')
);

CREATE INDEX IF NOT EXISTS idx_eta_cache_od
  ON eta_cache (origin_hex, dest_hex, is_traffic_aware);

CREATE INDEX IF NOT EXISTS idx_eta_cache_expires
  ON eta_cache (expires_at);

-- Periodic cleanup function for expired cache entries
CREATE OR REPLACE FUNCTION cleanup_route_caches()
RETURNS void AS $$
BEGIN
  DELETE FROM route_cache WHERE expires_at < NOW();
  DELETE FROM eta_cache WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Route cache config table for TTL tuning
CREATE TABLE IF NOT EXISTS cache_config (
  key   VARCHAR(64) PRIMARY KEY,
  value VARCHAR(256) NOT NULL
);

INSERT INTO cache_config (key, value) VALUES
  ('route_geometry_ttl_hours', '168'),  -- 7 days for static geometry
  ('route_traffic_eta_ttl_minutes', '15'),  -- 15 min for traffic-aware ETA
  ('route_static_eta_ttl_hours', '24')  -- 24 hours for static ETA
ON CONFLICT (key) DO NOTHING;
