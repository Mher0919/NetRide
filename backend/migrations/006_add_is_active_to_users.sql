-- backend/migrations/006_add_is_active_to_users.sql

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
