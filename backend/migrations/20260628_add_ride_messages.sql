-- backend/migrations/20260628_add_ride_messages.sql
--
-- Adds the persistent store for in-trip chat messages between driver and
-- rider. Messages are scoped to a trip; rows are deleted with the parent
-- ride via ON DELETE CASCADE (the cleanup service already prunes rides
-- older than the retention window).
--
-- Indices support the two query patterns:
--   - "load history when opening the chat sheet"   →  (trip_id, created_at)
--   - "tail incoming messages since X"             →  (trip_id, created_at)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS ride_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id      UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  sender_id    UUID NOT NULL,
  sender_role  TEXT NOT NULL CHECK (sender_role IN ('rider', 'driver')),
  body         TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ride_messages_trip_id_created_at_idx
  ON ride_messages (trip_id, created_at);