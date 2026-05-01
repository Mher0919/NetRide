-- backend/migrations/003_fix_user_schema.sql

-- Rename phone to phone_number if it exists and phone_number doesn't
DO $$ 
BEGIN 
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='phone') 
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='phone_number') THEN
        ALTER TABLE users RENAME COLUMN phone TO phone_number;
    END IF;
END $$;

-- Add is_verified column if missing
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;

-- Add date_of_birth column if missing
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth TIMESTAMPTZ;

-- Add profile_image_url column if missing
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_url TEXT;

-- Add password_hash column if missing
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Make phone_number and password_hash nullable
ALTER TABLE users ALTER COLUMN phone_number DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Ensure user_role enum values are correct (uppercase)
DO $$
BEGIN
    -- Check if 'rider' exists and rename it
    IF EXISTS (SELECT 1 FROM pg_enum JOIN pg_type ON pg_enum.enumtypid = pg_type.oid WHERE typname = 'user_role' AND enumlabel = 'rider') THEN
        ALTER TYPE user_role RENAME VALUE 'rider' TO 'RIDER';
    END IF;
    
    -- Check if 'driver' exists and rename it
    IF EXISTS (SELECT 1 FROM pg_enum JOIN pg_type ON pg_enum.enumtypid = pg_type.oid WHERE typname = 'user_role' AND enumlabel = 'driver') THEN
        ALTER TYPE user_role RENAME VALUE 'driver' TO 'DRIVER';
    END IF;
END $$;
