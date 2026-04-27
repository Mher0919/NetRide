-- backend/migrations/004_add_license_back_photo.sql
ALTER TABLE drivers ADD COLUMN license_photo_back_url TEXT;
