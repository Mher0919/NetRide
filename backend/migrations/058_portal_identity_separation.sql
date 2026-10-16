-- backend/migrations/058_portal_identity_separation.sql
--
-- COLAB (portal) ⇄ DRIVER/RIDER IDENTITY SEPARATION
-- ---------------------------------------------------------------------------
-- Problem this fixes:
--   `users.email` was globally UNIQUE, so a driver/rider and a
--   sponsor/partner/fleet colab account could never own the same email. The
--   portal flows worked around this by ATTACHING portal access to whichever
--   users row already had the email — including RIDER/DRIVER/ADMIN rows.
--   Consequences:
--     * disabling a colab login set `users.is_active = FALSE` on the
--       driver/rider identity too (and vice versa: a driver login auto-
--       reactivated the colab identity),
--     * portal login picked the single row by email, so a deactivated
--       driver/rider row surfaced "Your account is disabled" on the colab
--       dashboard,
--     * a colab password change overwrote the driver/rider password.
--
-- Identity model after this migration:
--   CONSUMER class (RIDER/DRIVER/ADMIN) and PORTAL class
--   (SPONSOR/PARTNER/FLEET) have SEPARATE email uniqueness namespaces.
--   The same email may exist in both classes as two independent identities.
--   A portal identity may be SHARED between sponsor, partner and fleet
--   accounts (that relationship is legitimate); it is never shared with a
--   driver/rider/admin account.
--
-- Legacy rows: any consumer identity that currently owns a portal account is
--   cloned into a new portal identity (same email, same password hash) and
--   the portal account rows are re-pointed to the clone. The consumer row is
--   left untouched, so driver/rider access is unchanged.
--
-- Safe to re-run (IF EXISTS / NOT EXISTS guards); transactional via the
-- migration runner.

-- ===========================================================================
-- 1. Replace the global email uniqueness with class-scoped uniqueness
-- ===========================================================================

DROP INDEX IF EXISTS public.users_email_key;
-- Replace the class indexes too if this file runs again after a change.
DROP INDEX IF EXISTS public.users_email_consumer_uniq;
DROP INDEX IF EXISTS public.users_email_portal_uniq;

-- One email per CONSUMER identity class. Case-insensitive: both auth flows
-- treat addresses case-insensitively.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_consumer_uniq
  ON public.users (lower(email))
  WHERE role IN ('RIDER', 'DRIVER', 'ADMIN');

-- One email per PORTAL identity class (sponsor/partner/fleet share one row).
-- Case-insensitive: portal login resolves with lower(email).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_portal_uniq
  ON public.users (lower(email))
  WHERE role IN ('SPONSOR', 'PARTNER', 'FLEET');

-- ===========================================================================
-- 2. Split legacy portal access off consumer identities
-- ===========================================================================

CREATE TEMP TABLE IF NOT EXISTS _portal_identity_split (
  old_user_id UUID,
  new_user_id UUID,
  email       TEXT
) ON COMMIT DROP;

TRUNCATE _portal_identity_split;

WITH legacy AS (
  SELECT DISTINCT u.id AS old_user_id,
         u.email,
         u.password_hash,
         u.full_name,
         u.phone_verified,
         u.password_changed_at
  FROM public.users u
  WHERE u.role IN ('RIDER', 'DRIVER', 'ADMIN')
    AND (
      EXISTS (SELECT 1 FROM public.sponsor_portal_accounts s WHERE s.user_id = u.id)
      OR EXISTS (SELECT 1 FROM public.partners p WHERE p.user_id = u.id)
      OR EXISTS (SELECT 1 FROM public.fleet_portal_accounts f WHERE f.user_id = u.id)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.users existing
      WHERE existing.email = u.email
        AND existing.role IN ('SPONSOR', 'PARTNER', 'FLEET')
        AND existing.id <> u.id
    )
),
inserted AS (
  INSERT INTO public.users
    (email, full_name, password_hash, role, is_verified, is_active,
     phone_verified, password_changed_at, created_at, updated_at)
  SELECT l.email,
         COALESCE(NULLIF(l.full_name, ''), 'Portal user'),
         l.password_hash,
         CASE
           WHEN EXISTS (SELECT 1 FROM public.sponsor_portal_accounts s WHERE s.user_id = l.old_user_id)
             THEN 'SPONSOR'::user_role
           WHEN EXISTS (SELECT 1 FROM public.partners p WHERE p.user_id = l.old_user_id)
             THEN 'PARTNER'::user_role
           ELSE 'FLEET'::user_role
         END,
         TRUE,
         TRUE,  -- identity enabled; the per-account is_active flag governs portal login
         COALESCE(l.phone_verified, FALSE),
         COALESCE(l.password_changed_at, NOW()),
         NOW(),
         NOW()
  FROM legacy l
  RETURNING id, email
)
INSERT INTO _portal_identity_split (old_user_id, new_user_id, email)
SELECT l.old_user_id, i.id, l.email
FROM legacy l
JOIN inserted i ON i.email = l.email;

-- Re-point every portal link to the new portal identity.
UPDATE public.sponsor_portal_accounts spa
SET user_id = m.new_user_id, updated_at = NOW()
FROM _portal_identity_split m
WHERE spa.user_id = m.old_user_id;

UPDATE public.partners p
SET user_id = m.new_user_id, updated_at = NOW()
FROM _portal_identity_split m
WHERE p.user_id = m.old_user_id;

UPDATE public.fleet_portal_accounts f
SET user_id = m.new_user_id, updated_at = NOW()
FROM _portal_identity_split m
WHERE f.user_id = m.old_user_id;

DROP TABLE IF EXISTS _portal_identity_split;
