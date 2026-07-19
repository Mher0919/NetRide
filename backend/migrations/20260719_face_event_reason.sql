-- backend/migrations/20260719_face_event_reason.sql

-- Store the human-readable reason a face check was flagged (or why it passed),
-- so admins can see at a glance what went wrong in the review queue.
ALTER TABLE face_check_events
  ADD COLUMN IF NOT EXISTS reason TEXT;
