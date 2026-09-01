// backend/src/middleware/portal.middleware.ts
//
// UNIFIED PORTAL GUARD — one guard for sponsor / partner / fleet accounts.
// The JWT carries a `portalType` claim (SPONSOR | PARTNER | FLEET) plus the
// owning entity id (`portalId`). Every request re-validates the underlying
// account row so disabled/suspended accounts are rejected instantly, then
// exposes `req.portal` for type-scoped queries.

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

export const portalMiddleware = async (req: PortalRequest, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { role, portalType, portalId } = user;
  if (!PORTAL_TYPES.includes(portalType) || !portalId) {
    return res.status(403).json({ error: 'Access denied. Portal account required.' });
  }

  try {
    if (portalType === 'SPONSOR') {
      const r = await pool.query(
        `SELECT spa.sponsor_id, spa.is_active, spa.must_change_password, s.status
         FROM sponsor_portal_accounts spa
         JOIN sponsors s ON s.id = spa.sponsor_id
         WHERE spa.sponsor_id = $1 AND spa.user_id = $2`,
        [portalId, user.id],
      );
      const row = r.rows[0];
      if (!row || !row.is_active) {
        return res.status(403).json({ error: 'Your sponsor portal account is inactive.' });
      }
      if (!row.must_change_password && row.status === 'SUSPENDED') {
        return res.status(403).json({ error: 'Your sponsor account is suspended.' });
      }
    } else if (portalType === 'PARTNER') {
      const r = await pool.query(
        `SELECT id, status, must_change_password FROM partners
         WHERE id = $1 AND ($2::uuid IS NULL OR user_id = $2)`,
        [portalId, user.id],
      );
      const row = r.rows[0];
      if (!row) return res.status(403).json({ error: 'Partner account not found.' });
      if (!row.must_change_password && row.status !== 'ACTIVE') {
        return res.status(403).json({ error: 'Your partner account is not active.' });
      }
    } else {
      const r = await pool.query(
        `SELECT fpa.fleet_id, fpa.is_active, fpa.must_change_password, f.is_active AS fleet_active
         FROM fleet_portal_accounts fpa
         JOIN fleet_partners f ON f.id = fpa.fleet_id
         WHERE fpa.fleet_id = $1 AND fpa.user_id = $2`,
        [portalId, user.id],
      );
      const row = r.rows[0];
      if (!row || !row.is_active) {
        return res.status(403).json({ error: 'Your fleet portal account is inactive.' });
      }
      if (!row.must_change_password && !row.fleet_active) {
        return res.status(403).json({ error: 'Your fleet is disabled.' });
      }
    }

    req.portal = { type: portalType, id: portalId, userId: user.id, email: user.email };
    next();
  } catch (err) {
    next(err);
  }
};