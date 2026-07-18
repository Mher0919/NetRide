-- Migration 029: Migrate legacy file URLs to permanent storage_files references
--
-- This migration scans all existing image URL columns for known URL patterns
-- and creates storage_files records for each. It then updates the column to
-- use the /api/files/{id} format.
--
-- Patterns detected:
--   - Supabase public URLs: https://*.supabase.co/storage/v1/object/public/uploads/{path}
--   - Localhost URLs: http://localhost:3000/uploads/{path}
--   - Render/APP_URL URLs: https://*.onrender.com/uploads/{path}

-- Helper function to extract filename from a URL and create a storage_files record
CREATE OR REPLACE FUNCTION migrate_file_url(
  p_url TEXT,
  p_user_id UUID,
  p_column_name TEXT
) RETURNS UUID AS $$
DECLARE
  v_file_id UUID;
  v_bucket TEXT;
  v_path TEXT;
  v_supabase_url TEXT;
BEGIN
  IF p_url IS NULL OR p_url = '' THEN
    RETURN NULL;
  END IF;

  -- Skip already-migrated entries
  IF p_url LIKE '/api/files/%' THEN
    RETURN NULL;
  END IF;

  -- Determine bucket and path
  IF p_url LIKE '%supabase.co/storage/v1/object/public/uploads/%' THEN
    v_bucket := 'supabase';
    v_path := substring(p_url FROM 'uploads/(.+)$');
  ELSIF p_url LIKE '%/uploads/%' THEN
    v_bucket := 'local';
    v_path := 'local/' || substring(p_url FROM 'uploads/(.+)$');
  ELSE
    -- Unknown URL pattern — skip
    RETURN NULL;
  END IF;

  IF v_path IS NULL OR v_path = '' THEN
    RETURN NULL;
  END IF;

  -- Check if this path already has a storage_files record
  SELECT id INTO v_file_id FROM storage_files
  WHERE bucket = v_bucket AND path = v_path
  LIMIT 1;

  IF v_file_id IS NOT NULL THEN
    RETURN v_file_id;
  END IF;

  -- Create storage_files record
  INSERT INTO storage_files (user_id, bucket, path, original_name, mimetype, size_bytes)
  VALUES (p_user_id, v_bucket, v_path, p_column_name, 'image/jpeg', NULL)
  RETURNING id INTO v_file_id;

  RETURN v_file_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Migrate users.profile_image_url
-- ============================================================
DO $$
DECLARE
  rec RECORD;
  fid UUID;
BEGIN
  FOR rec IN SELECT id, profile_image_url FROM users WHERE profile_image_url IS NOT NULL AND profile_image_url != '' AND profile_image_url NOT LIKE '/api/files/%' LOOP
    fid := migrate_file_url(rec.profile_image_url, rec.id, 'profile_image_url');
    IF fid IS NOT NULL THEN
      UPDATE users SET profile_image_url = '/api/files/' || fid WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- Migrate users.id_photo_front_url, id_photo_back_url, face_enrollment_url
-- ============================================================
DO $$
DECLARE
  rec RECORD;
  fid UUID;
BEGIN
  FOR rec IN SELECT id, id_photo_front_url FROM users WHERE id_photo_front_url IS NOT NULL AND id_photo_front_url != '' AND id_photo_front_url NOT LIKE '/api/files/%' LOOP
    fid := migrate_file_url(rec.id_photo_front_url, rec.id, 'id_photo_front_url');
    IF fid IS NOT NULL THEN
      UPDATE users SET id_photo_front_url = '/api/files/' || fid WHERE id = rec.id;
    END IF;
  END LOOP;
  FOR rec IN SELECT id, id_photo_back_url FROM users WHERE id_photo_back_url IS NOT NULL AND id_photo_back_url != '' AND id_photo_back_url NOT LIKE '/api/files/%' LOOP
    fid := migrate_file_url(rec.id_photo_back_url, rec.id, 'id_photo_back_url');
    IF fid IS NOT NULL THEN
      UPDATE users SET id_photo_back_url = '/api/files/' || fid WHERE id = rec.id;
    END IF;
  END LOOP;
  FOR rec IN SELECT id, face_enrollment_url FROM users WHERE face_enrollment_url IS NOT NULL AND face_enrollment_url != '' AND face_enrollment_url NOT LIKE '/api/files/%' LOOP
    fid := migrate_file_url(rec.face_enrollment_url, rec.id, 'face_enrollment_url');
    IF fid IS NOT NULL THEN
      UPDATE users SET face_enrollment_url = '/api/files/' || fid WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- Migrate drivers.*_url columns
-- ============================================================
DO $$
DECLARE
  rec RECORD;
  fid UUID;
BEGIN
  FOR rec IN SELECT user_id, license_photo_url, license_photo_back_url, insurance_photo_url, registration_photo_url
             FROM drivers
             WHERE license_photo_url IS NOT NULL OR license_photo_back_url IS NOT NULL
                OR insurance_photo_url IS NOT NULL OR registration_photo_url IS NOT NULL LOOP
    IF rec.license_photo_url IS NOT NULL AND rec.license_photo_url NOT LIKE '/api/files/%' THEN
      fid := migrate_file_url(rec.license_photo_url, rec.user_id, 'license_photo_url');
      IF fid IS NOT NULL THEN UPDATE drivers SET license_photo_url = '/api/files/' || fid WHERE user_id = rec.user_id; END IF;
    END IF;
    IF rec.license_photo_back_url IS NOT NULL AND rec.license_photo_back_url NOT LIKE '/api/files/%' THEN
      fid := migrate_file_url(rec.license_photo_back_url, rec.user_id, 'license_photo_back_url');
      IF fid IS NOT NULL THEN UPDATE drivers SET license_photo_back_url = '/api/files/' || fid WHERE user_id = rec.user_id; END IF;
    END IF;
    IF rec.insurance_photo_url IS NOT NULL AND rec.insurance_photo_url NOT LIKE '/api/files/%' THEN
      fid := migrate_file_url(rec.insurance_photo_url, rec.user_id, 'insurance_photo_url');
      IF fid IS NOT NULL THEN UPDATE drivers SET insurance_photo_url = '/api/files/' || fid WHERE user_id = rec.user_id; END IF;
    END IF;
    IF rec.registration_photo_url IS NOT NULL AND rec.registration_photo_url NOT LIKE '/api/files/%' THEN
      fid := migrate_file_url(rec.registration_photo_url, rec.user_id, 'registration_photo_url');
      IF fid IS NOT NULL THEN UPDATE drivers SET registration_photo_url = '/api/files/' || fid WHERE user_id = rec.user_id; END IF;
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- Migrate driver_vehicles.*_url columns
-- ============================================================
DO $$
DECLARE
  rec RECORD;
  fid UUID;
BEGIN
  FOR rec IN SELECT id, driver_id, license_plate_photo_url, inspection_photo_url, insurance_photo_url, registration_photo_url
             FROM driver_vehicles
             WHERE license_plate_photo_url IS NOT NULL OR inspection_photo_url IS NOT NULL
                OR insurance_photo_url IS NOT NULL OR registration_photo_url IS NOT NULL LOOP
    IF rec.license_plate_photo_url IS NOT NULL AND rec.license_plate_photo_url NOT LIKE '/api/files/%' THEN
      fid := migrate_file_url(rec.license_plate_photo_url, rec.driver_id, 'license_plate_photo_url');
      IF fid IS NOT NULL THEN UPDATE driver_vehicles SET license_plate_photo_url = '/api/files/' || fid WHERE id = rec.id; END IF;
    END IF;
    IF rec.inspection_photo_url IS NOT NULL AND rec.inspection_photo_url NOT LIKE '/api/files/%' THEN
      fid := migrate_file_url(rec.inspection_photo_url, rec.driver_id, 'inspection_photo_url');
      IF fid IS NOT NULL THEN UPDATE driver_vehicles SET inspection_photo_url = '/api/files/' || fid WHERE id = rec.id; END IF;
    END IF;
    IF rec.insurance_photo_url IS NOT NULL AND rec.insurance_photo_url NOT LIKE '/api/files/%' THEN
      fid := migrate_file_url(rec.insurance_photo_url, rec.driver_id, 'insurance_photo_url');
      IF fid IS NOT NULL THEN UPDATE driver_vehicles SET insurance_photo_url = '/api/files/' || fid WHERE id = rec.id; END IF;
    END IF;
    IF rec.registration_photo_url IS NOT NULL AND rec.registration_photo_url NOT LIKE '/api/files/%' THEN
      fid := migrate_file_url(rec.registration_photo_url, rec.driver_id, 'registration_photo_url');
      IF fid IS NOT NULL THEN UPDATE driver_vehicles SET registration_photo_url = '/api/files/' || fid WHERE id = rec.id; END IF;
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- Migrate driver_vehicle_submissions.*_url columns
-- ============================================================
DO $$
DECLARE
  rec RECORD;
  fid UUID;
BEGIN
  FOR rec IN SELECT id, driver_id, registration_photo_url, insurance_photo_url, inspection_photo_url
             FROM driver_vehicle_submissions
             WHERE registration_photo_url IS NOT NULL OR insurance_photo_url IS NOT NULL OR inspection_photo_url IS NOT NULL LOOP
    IF rec.registration_photo_url IS NOT NULL AND rec.registration_photo_url NOT LIKE '/api/files/%' THEN
      fid := migrate_file_url(rec.registration_photo_url, rec.driver_id, 'registration_photo_url');
      IF fid IS NOT NULL THEN UPDATE driver_vehicle_submissions SET registration_photo_url = '/api/files/' || fid WHERE id = rec.id; END IF;
    END IF;
    IF rec.insurance_photo_url IS NOT NULL AND rec.insurance_photo_url NOT LIKE '/api/files/%' THEN
      fid := migrate_file_url(rec.insurance_photo_url, rec.driver_id, 'insurance_photo_url');
      IF fid IS NOT NULL THEN UPDATE driver_vehicle_submissions SET insurance_photo_url = '/api/files/' || fid WHERE id = rec.id; END IF;
    END IF;
    IF rec.inspection_photo_url IS NOT NULL AND rec.inspection_photo_url NOT LIKE '/api/files/%' THEN
      fid := migrate_file_url(rec.inspection_photo_url, rec.driver_id, 'inspection_photo_url');
      IF fid IS NOT NULL THEN UPDATE driver_vehicle_submissions SET inspection_photo_url = '/api/files/' || fid WHERE id = rec.id; END IF;
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- Migrate driver_document_requirements.*_url columns
-- ============================================================
DO $$
DECLARE
  rec RECORD;
  fid UUID;
BEGIN
  FOR rec IN SELECT id, driver_id, current_document_url, new_document_url
             FROM driver_document_requirements
             WHERE current_document_url IS NOT NULL OR new_document_url IS NOT NULL LOOP
    IF rec.current_document_url IS NOT NULL AND rec.current_document_url NOT LIKE '/api/files/%' THEN
      fid := migrate_file_url(rec.current_document_url, rec.driver_id, 'current_document_url');
      IF fid IS NOT NULL THEN UPDATE driver_document_requirements SET current_document_url = '/api/files/' || fid WHERE id = rec.id; END IF;
    END IF;
    IF rec.new_document_url IS NOT NULL AND rec.new_document_url NOT LIKE '/api/files/%' THEN
      fid := migrate_file_url(rec.new_document_url, rec.driver_id, 'new_document_url');
      IF fid IS NOT NULL THEN UPDATE driver_document_requirements SET new_document_url = '/api/files/' || fid WHERE id = rec.id; END IF;
    END IF;
  END LOOP;
END $$;

-- Drop the helper function
DROP FUNCTION IF EXISTS migrate_file_url;

-- Note: car_photo_urls (TEXT[]) is not migrated by this script
-- as it requires array handling. Run the companion Node.js script for that.
