-- 030_user_block_and_rating_flag.sql
-- Add BLOCKED verification status, a blocked_reason column on users, and a
-- flagged_for_review column on ratings (set when a rider leaves <3 stars with a note).

-- Extend the verification_status enum with BLOCKED.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'verification_status' AND e.enumlabel = 'BLOCKED'
  ) THEN
    ALTER TYPE verification_status ADD VALUE 'BLOCKED';
  END IF;
END $$;

-- Blocked reason (admin note shown to the user).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'blocked_reason'
  ) THEN
    ALTER TABLE users ADD COLUMN blocked_reason TEXT;
  END IF;
END $$;

-- Flagged-for-review on ratings (low-star + note reviews).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ratings' AND column_name = 'flagged_for_review'
  ) THEN
    ALTER TABLE ratings ADD COLUMN flagged_for_review BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS idx_ratings_flagged
      ON ratings (flagged_for_review) WHERE flagged_for_review = TRUE;
  END IF;
END $$;
