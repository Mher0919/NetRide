-- Migration 034: Ride-scoped authoritative route store
-- The rider-generated route is the single source of truth for a ride.
-- Both rider and driver use the exact same stored route; reroutes
-- replace the leg entry. Geometry is stored as a [lng,lat] coordinate
-- array plus an H3 OD fingerprint for the OD-reuse cache lookups.

CREATE TABLE IF NOT EXISTS ride_routes (
  id                    BIGSERIAL PRIMARY KEY,
  ride_id               UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  leg                   VARCHAR(16) NOT NULL,          -- 'pickup' | 'destination'
  origin_lat            DOUBLE PRECISION NOT NULL,
  origin_lng            DOUBLE PRECISION NOT NULL,
  dest_lat              DOUBLE PRECISION NOT NULL,
  dest_lng              DOUBLE PRECISION NOT NULL,
  origin_h3             VARCHAR(15) NOT NULL,          -- H3 cell at resolution 8
  dest_h3               VARCHAR(15) NOT NULL,
  distance_meters       DOUBLE PRECISION NOT NULL,
  duration_seconds      DOUBLE PRECISION NOT NULL,
  traffic_duration_seconds DOUBLE PRECISION,           -- NULL = static duration
  eta_seconds           DOUBLE PRECISION NOT NULL,
  polyline              JSONB NOT NULL,                -- [[lng,lat], ...]
  steps                 JSONB DEFAULT '[]'::jsonb,
  route_hash            VARCHAR(64) NOT NULL,          -- sha1 of polyline JSON
  engine                VARCHAR(32) NOT NULL DEFAULT 'GoogleRoutes',
  cache_hit             BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at            TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  UNIQUE (ride_id, leg)
);

CREATE INDEX IF NOT EXISTS idx_ride_routes_ride
  ON ride_routes (ride_id);

CREATE INDEX IF NOT EXISTS idx_ride_routes_expires
  ON ride_routes (expires_at);

CREATE INDEX IF NOT EXISTS idx_ride_routes_od_h3
  ON ride_routes (origin_h3, dest_h3);
