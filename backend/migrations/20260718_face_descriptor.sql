-- backend/migrations/20260718_face_descriptor.sql

-- Store the face-api.js 128-d descriptor (as JSON) alongside the enrolled
-- reference image URL. The descriptor is the source of truth for identity
-- matching; the image URL is kept only for admin review.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS face_enrollment_descriptor JSONB;
