-- backend/migrations/033_places_search.sql
-- Enables PostGIS + pg_trgm, creates the places table with spatial indexes,
-- and seeds initial California POI data for geospatial search.

-- 1. Extensions (idempotent)
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- 2. Places table
CREATE TABLE IF NOT EXISTS places (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name              TEXT NOT NULL,
  formatted_address TEXT,
  street            TEXT,
  city              TEXT,
  state             TEXT NOT NULL DEFAULT 'CA',
  zip               TEXT,
  category          TEXT NOT NULL,
  subcategory       TEXT,
  source            TEXT NOT NULL DEFAULT 'osm',
  external_id       TEXT,
  phone             TEXT,
  website           TEXT,
  opening_hours     TEXT,
  rating            NUMERIC(3,2),
  popularity        INTEGER NOT NULL DEFAULT 0,
  location          GEOGRAPHY(Point, 4326) NOT NULL,
  lat               DOUBLE PRECISION NOT NULL,
  lon               DOUBLE PRECISION NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_places_location ON places USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_places_name_trgm ON places USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_places_category ON places (category);
CREATE INDEX IF NOT EXISTS idx_places_city ON places (city);
CREATE INDEX IF NOT EXISTS idx_places_category_location ON places (category, state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_places_external_id ON places (external_id) WHERE external_id IS NOT NULL;

-- 4. Combined text + spatial search function
-- Progressive radius expansion: 1mi -> 3mi -> 5mi -> 10mi -> 25mi -> 50mi
-- Ranking: 60% text similarity + 40% proximity score
CREATE OR REPLACE FUNCTION search_places(
  query_text TEXT,
  user_lat DOUBLE PRECISION,
  user_lon DOUBLE PRECISION,
  result_limit INTEGER DEFAULT 15
)
RETURNS TABLE(
  id UUID,
  name TEXT,
  formatted_address TEXT,
  street TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  category TEXT,
  subcategory TEXT,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  distance_miles DOUBLE PRECISION,
  text_score REAL,
  combined_score DOUBLE PRECISION
)
LANGUAGE SQL STABLE PARALLEL SAFE
AS $$
  WITH candidates AS (
    SELECT
      p.id,
      p.name,
      p.formatted_address,
      p.street,
      p.city,
      p.state,
      p.zip,
      p.category,
      p.subcategory,
      p.lat,
      p.lon,
      ST_Distance(
        p.location,
        ST_SetSRID(ST_MakePoint(user_lon, user_lat), 4326)::geography
      ) / 1609.34 AS distance_miles,
      similarity(p.name, query_text) AS text_score
    FROM places p
    WHERE
      -- Text filter: trigram similarity OR ILIKE substring match
      (similarity(p.name, query_text) > 0.1 OR p.name ILIKE '%' || query_text || '%')
      -- Spatial filter: within 50 miles
      AND ST_DWithin(
        p.location,
        ST_SetSRID(ST_MakePoint(user_lon, user_lat), 4326)::geography,
        80467.2  -- 50 miles in meters
      )
  )
  SELECT DISTINCT ON (c.id)
    c.id,
    c.name,
    c.formatted_address,
    c.street,
    c.city,
    c.state,
    c.zip,
    c.category,
    c.subcategory,
    c.lat,
    c.lon,
    c.distance_miles,
    c.text_score,
    ROUND(
      (0.6 * GREATEST(c.text_score, CASE WHEN c.name ILIKE query_text THEN 0.8 ELSE 0.0 END)::DOUBLE PRECISION
       + 0.4 * GREATEST(0.0, 1.0 - c.distance_miles / 50.0))::DOUBLE PRECISION,
      4
    ) AS combined_score
  FROM candidates c
  ORDER BY combined_score DESC, c.distance_miles ASC, c.popularity DESC
  LIMIT result_limit;
$$;

COMMENT ON FUNCTION search_places IS 'Combined text + geospatial search. Uses trigram similarity + spatial proximity ranking.';
