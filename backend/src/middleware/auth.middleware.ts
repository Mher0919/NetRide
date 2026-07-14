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
