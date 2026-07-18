-- Storage Files Table
-- Stores permanent file references that survive redeploys and URL changes.
-- Bucket options: 'supabase', 'local'
-- Path is relative to the bucket root.

CREATE TABLE IF NOT EXISTS storage_files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  bucket          TEXT NOT NULL CHECK (bucket IN ('supabase', 'local')),
  path            TEXT NOT NULL,
  original_name   TEXT,
  mimetype        TEXT DEFAULT 'image/jpeg',
  size_bytes      BIGINT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_storage_files_user_id ON storage_files(user_id);
CREATE INDEX IF NOT EXISTS idx_storage_files_path ON storage_files(path);
