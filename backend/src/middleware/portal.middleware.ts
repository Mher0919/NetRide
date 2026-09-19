// backend/src/middleware/portal.middleware.ts
//
// UNIFIED PORTAL GUARD — one guard for sponsor / partner / fleet accounts.
// Portal access is resolved from the account tables by user_id (a single
// login can own ANY combination of account types). The ACTIVE dashboard is
// chosen per request via the `x-portal-type` header; without it, the
// highest-priority available type is used. Disabled/suspended accounts are
// rejected instantly, then `req.portal` is exposed for type-scoped queries.
//
// The guard is ALSO the server-side enforcement point for the first-login
// temporary-password state: while `must_change_password` is true the user
// may ONLY call the change-password endpoint (which uses
// `portalPasswordChangeMiddleware`) — every data endpoint is rejected with
// 403 until the temporary password has been replaced. A malicious client
// can therefore never skip the forced password change by editing routes,
// localStorage, or request payloads.

import { Request, Response, NextFunction } from 'express';
import { pool } from '../config/database';

export interface PortalRequest extends Request {
  portal?: {
    type: 'SPONSOR' | 'PARTNER' | 'FLEET';
    id: string;
    userId: string;
    email: string;
    mustChangePassword: boolean;
  };
}

const PORTAL_TYPES = ['SPONSOR', 'PARTNER', 'FLEET'];
const PRIORITY: Record<string, number> = { SPONSOR: 1, PARTNER: 2, FLEET: 3 };

const MUST_CHANGE_PASSWORD_MESSAGE =
  'You must set a new password before using the portal. Please use the change-password screen.';

/** Every portal account attached to the user, with access-blocking flags. */
async function resolveAccounts(userId: string): Promise<Array<{ type: string; id: string; blocked: boolean; must_change_password: boolean }>> {
  const res = await pool.query(
    `SELECT type, id, blocked, must_change_password
     FROM (
       SELECT 'SPONSOR'::text AS type, spa.sponsor_id::text AS id,
              (s.status = 'SUSPENDED' AND NOT spa.must_change_password) AS blocked,
              spa.must_change_password
       FROM sponsor_portal_accounts spa
       JOIN sponsors s ON s.id = spa.sponsor_id
       WHERE spa.user_id = $1 AND spa.is_active = TRUE
       UNION ALL
       SELECT 'PARTNER'::text AS type, p.id::text AS id,
              (p.status <> 'ACTIVE' AND NOT p.must_change_password) AS blocked,
              p.must_change_password
       FROM partners p WHERE p.user_id = $1
       UNION ALL
       SELECT 'FLEET'::text AS type, fpa.fleet_id::text AS id,
              ((NOT fpa.is_active OR NOT f.is_active) AND NOT fpa.must_change_password) AS blocked,
              fpa.must_change_password
       FROM fleet_portal_accounts fpa
       JOIN fleet_partners f ON f.id = fpa.fleet_id
       WHERE fpa.user_id = $1
     ) t`,
    [userId],
  );
  return res.rows;
}

/**
 * Shared resolution: authenticates the request as a portal user and resolves
 * the active account type. When `enforcePasswordChange` is true (data
 * endpoints) the pending temporary-password state blocks everything except
 * the change-password route.
 */
async function portalGuard(
  req: PortalRequest,
  res: Response,
  next: NextFunction,
  enforcePasswordChange: boolean,
): Promise<Response | void> {
  const user = (req as any).user;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const accounts = await resolveAccounts(user.id);
    if (accounts.length === 0) {
      return res.status(403).json({ error: 'Access denied. Portal account required.' });
    }

    const requested = String(req.headers['x-portal-type'] ?? '').toUpperCase();
    let active: { type: string; id: string; blocked: boolean; must_change_password: boolean };
    if (requested && PORTAL_TYPES.includes(requested)) {
      const target = accounts.find((a) => a.type === requested);
      if (!target) {
        return res.status(403).json({ error: 'You do not have access to this dashboard type.' });
      }
      active = target;
    } else {
      active = accounts.reduce((best, a) =>
        !best || PRIORITY[a.type] < PRIORITY[best.type] ? a : best,
        accounts[0],
      );
    }

    if (active.blocked) {
      return res.status(403).json({ error: 'This account type is disabled. Contact NetRide support.' });
    }

    if (enforcePasswordChange && active.must_change_password) {
      return res.status(403).json({ error: MUST_CHANGE_PASSWORD_MESSAGE });
    }

    req.portal = {
      type: active.type as any,
      id: active.id,
      userId: user.id,
      email: user.email,
      mustChangePassword: active.must_change_password,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/** Data-endpoint guard: rejects accounts still on the temporary password. */
export const portalMiddleware = async (req: PortalRequest, res: Response, next: NextFunction) => {
  await portalGuard(req, res, next, true);
};

/**
 * Change-password guard: resolves the portal account so the user can clear
 * `must_change_password`, but the pending temporary-password state never
 * blocks this endpoint — it is the ONLY endpoint available in that state.
 */
export const portalPasswordChangeMiddleware = async (req: PortalRequest, res: Response, next: NextFunction) => {
  await portalGuard(req, res, next, false);
};
