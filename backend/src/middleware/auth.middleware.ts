// backend/src/middleware/auth.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../modules/auth/auth.service';
import { pool } from '../config/database';
import { env } from '../config/env';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    role: string;
    email: string;
  };
}

export const authMiddleware = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(' ')[1];

  // If no token, return unauthorized
  if (!token) {
    console.warn(`[AUTH] ❌ No token provided for ${req.originalUrl}`);
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  try {
    const decoded = AuthService.verifyToken(token);
    req.user = decoded;
    next();
  } catch (err: any) {
    console.error(`[AUTH] ❌ Verification failed for ${req.originalUrl}: ${err.message}`);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

export const adminMiddleware = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied. Administrator privileges required.' });
  }
  next();
};

/**
 * SPONSOR portal guard. The JWT for portal sessions carries role='SPONSOR'
 * plus the `sponsorId` claim (issued by SponsorService). Sponsors can never
 * escalate to ADMIN/RIDER and vice versa — the claim is verified against the
 * sponsor_portal_accounts row so disabled accounts are rejected instantly.
 * (Spec §44-45, §78-80: sponsor A must never see sponsor B's data — all
 * portal queries are scoped by req.sponsor.id below.)
 */
export const sponsorMiddleware = async (req: any, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== 'SPONSOR' || !req.user.sponsorId) {
    return res.status(403).json({ error: 'Access denied. Sponsor account required.' });
  }
  try {
    const resq = await pool.query(
      `SELECT spa.id FROM sponsor_portal_accounts spa
       JOIN sponsors s ON s.id = spa.sponsor_id
       WHERE spa.sponsor_id = $1 AND spa.is_active = TRUE
         AND s.status <> 'SUSPENDED'`,
      [req.user.sponsorId],
    );
    if (resq.rows.length === 0) {
      return res.status(403).json({ error: 'Your sponsor account is inactive or suspended.' });
    }
    req.sponsor = { id: req.user.sponsorId, userId: req.user.id, email: req.user.email };
    next();
  } catch (err) {
    next(err);
  }
};

export const riderMiddleware = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== 'RIDER') {
    return res.status(403).json({ error: 'Access denied. Rider account required.' });
  }
  next();
};

export const driverMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(403).json({ error: 'Access denied. Driver account required.' });
  }
  if (req.user.role === 'DRIVER' || req.user.role === 'ADMIN') {
    return next();
  }
  // Dual-role: user signed up as RIDER but has a drivers row
  try {
    const result = await pool.query('SELECT 1 FROM drivers WHERE user_id = $1', [req.user.id]);
    if (result.rows.length > 0) {
      return next();
    }
    return res.status(403).json({ error: 'Access denied. Driver account required.' });
  } catch (err) {
    next(err);
  }
};
