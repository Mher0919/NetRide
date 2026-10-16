// backend/src/modules/portal/portal-identities.ts
//
// PORTAL IDENTITY RESOLUTION — the single source of truth for "who is a
// colab (sponsor/partner/fleet) identity".
//
// Identity model (migration 058):
//   CONSUMER class  → users.role IN ('RIDER','DRIVER','ADMIN')
//   PORTAL class    → users.role IN ('SPONSOR','PARTNER','FLEET')
//
// The two classes have SEPARATE email uniqueness namespaces: a driver/rider
// may hold the same email as a colab account without the two being related.
// A PORTAL identity may be shared between sponsor, partner and fleet
// accounts (that relationship is intended); it must never be a driver,
// rider or admin row.
//
// Every credibility decision (login, account linking, admin pickers) MUST
// resolve through this module so the classes can never bleed into each other.

import { pool } from '../../config/database';

export const PORTAL_ROLES = ['SPONSOR', 'PARTNER', 'FLEET'] as const;
export type PortalRole = (typeof PORTAL_ROLES)[number];

export interface PortalIdentity {
  id: string;
  email: string;
  role: PortalRole;
  password_hash: string | null;
  is_active: boolean;
}

/** SQL predicate (inlined into a query) that is true when `alias` owns at least one portal account. */
export const HAS_PORTAL_ACCOUNT_SQL = (alias = 'u'): string => `(
  EXISTS (SELECT 1 FROM sponsor_portal_accounts spa WHERE spa.user_id = ${alias}.id)
  OR EXISTS (SELECT 1 FROM partners pt WHERE pt.user_id = ${alias}.id)
  OR EXISTS (SELECT 1 FROM fleet_portal_accounts fpa WHERE fpa.user_id = ${alias}.id)
)`;

/** SQL predicate that is true when `alias` is a PORTAL-class identity. */
export const IS_PORTAL_IDENTITY_SQL = (alias = 'u'): string =>
  `${alias}.role IN ('SPONSOR','PARTNER','FLEET')`;

/**
 * The PORTAL identity for an email (sponsor/partner/fleet class) that owns
 * at least one portal account. Returns null when only consumer identities
 * (driver/rider/admin) or no users exist for that email.
 */
export async function findPortalIdentityByEmail(
  email: string,
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> } = pool,
): Promise<PortalIdentity | null> {
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!normalized) return null;
  const res = await client.query(
    `SELECT u.id, u.email, u.role, u.password_hash, u.is_active
     FROM users u
     WHERE lower(u.email) = $1
       AND u.role IN ('SPONSOR','PARTNER','FLEET')
       AND ${HAS_PORTAL_ACCOUNT_SQL('u')}
     ORDER BY CASE u.role WHEN 'SPONSOR' THEN 1 WHEN 'PARTNER' THEN 2 ELSE 3 END
     LIMIT 1`,
    [normalized],
  );
  return (res.rows[0] as PortalIdentity) ?? null;
}

/**
 * True when the user id belongs to a PORTAL-class identity (never a
 * driver/rider/admin). Used to reject admin-picker selections and legacy
 * consumer rows before linking a portal account.
 */
export async function isPortalIdentity(
  userId: string,
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> } = pool,
): Promise<boolean> {
  if (!userId) return false;
  const res = await client.query(
    `SELECT 1 FROM users u
     WHERE u.id = $1 AND ${IS_PORTAL_IDENTITY_SQL('u')}
     LIMIT 1`,
    [userId],
  );
  return res.rows.length > 0;
}

/** True when the user owns at least one portal account row. */
export async function hasPortalAccount(
  userId: string,
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> } = pool,
): Promise<boolean> {
  if (!userId) return false;
  const res = await client.query(
    `SELECT 1 FROM users u WHERE u.id = $1 AND ${HAS_PORTAL_ACCOUNT_SQL('u')} LIMIT 1`,
    [userId],
  );
  return res.rows.length > 0;
}
