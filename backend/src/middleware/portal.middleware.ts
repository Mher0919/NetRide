// backend/src/middleware/portal.middleware.ts
//
// UNIFIED PORTAL GUARD — one guard for sponsor / partner / fleet accounts.
// Portal access is resolved from the account tables by user_id (a single
// login can own ANY combination of account types). The ACTIVE dashboard is
// chosen per request via the `x-portal-type` header; without it, the
// highest-priority available type is used. Disabled/suspended accounts are
// rejected instantly, then `req.portal` is exposed for type-scoped queries.

import { Request, Response, NextFunction } from 'express';
import { pool } from '../config/database';

export interface PortalRequest extends Request {
  portal?: {
    type: 'SPONSOR' | 'PARTNER' | 'FLEET';
    id: string;
    userId: string;
    email: string;
  };
}

const PORTAL_TYPES = ['SPONSOR', 'PARTNER', 'FLEET'];
const PRIORITY: Record<string, number> = { SPONSOR: 1, PARTNER: 2, FLEET: 3 };

/** Every portal account attached to the user, with access-blocking flags. */
async function resolveAccounts(userId: string): Promise<Array<{ type: string; id: string; blocked: boolean }>> {
  const res = await pool.query(
    `SELECT type, id, blocked
     FROM (
       SELECT 'SPONSOR'::text AS type, spa.sponsor_id::text AS id,
              (s.status = 'SUSPENDED' AND NOT spa.must_change_password) AS blocked
       FROM sponsor_portal_accounts spa
       JOIN sponsors s ON s.id = spa.sponsor_id
       WHERE spa.user_id = $1 AND spa.is_active = TRUE
       UNION ALL
       SELECT 'PARTNER'::text AS type, p.id::text AS id,
              (p.status <> 'ACTIVE' AND NOT p.must_change_password) AS blocked
       FROM partners p WHERE p.user_id = $1
       UNION ALL
       SELECT 'FLEET'::text AS type, fpa.fleet_id::text AS id,
              ((NOT fpa.is_active OR NOT f.is_active) AND NOT fpa.must_change_password) AS blocked
       FROM fleet_portal_accounts fpa
       JOIN fleet_partners f ON f.id = fpa.fleet_id
       WHERE fpa.user_id = $1
     ) t`,
    [userId],
  );
  return res.rows;
}

export const portalMiddleware = async (req: PortalRequest, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const accounts = await resolveAccounts(user.id);
    if (accounts.length === 0) {
      return res.status(403).json({ error: 'Access denied. Portal account required.' });
    }

    const requested = String(req.headers['x-portal-type'] ?? '').toUpperCase();
    let active: { type: string; id: string; blocked: boolean };
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

    req.portal = { type: active.type as any, id: active.id, userId: user.id, email: user.email };
    next();
  } catch (err) {
    next(err);
  }
};