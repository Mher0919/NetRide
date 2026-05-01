-- backend/migrations/005_add_insurance_registration.sql

ALTER TABLE drivers ADD COLUMN insurance_photo_url TEXT;
ALTER TABLE drivers ADD COLUMN registration_photo_url TEXT;
