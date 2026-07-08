-- backend/migrations/010_add_user_id_photos.sql

-- Add ID photo fields to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_photo_front_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_photo_back_url TEXT;
