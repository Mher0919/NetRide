-- backend/migrations/047_unified_portal_accounts.sql
--
-- Unified partner portal foundation: adds the PARTNER + FLEET user roles,
-- links `partners` rows to their login user, and introduces
-- `fleet_portal_accounts` so fleet partners get the same first-login
-- password-change flow as sponsors.
--
-- Safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

-- ===========================================================================
-- 1. ROLES
-- ===========================================================================

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'PARTNER';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'FLEET';

-- ===========================================================================
-- 2. PARTNERS: link login user + forced password change
-- ===========================================================================

ALTER TABLE partners ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS idx_partners_user_id ON partners (user_id);

-- ===========================================================================
-- 3. FLEET PORTAL ACCOUNTS (mirrors sponsor_portal_accounts)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS fleet_portal_accounts (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fleet_id              UUID NOT NULL REFERENCES fleet_partners(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password  BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_admin_id   UUID,
  last_login_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (fleet_id),
  UNIQUE (user_id)
);