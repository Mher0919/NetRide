// backend/src/middleware/auth.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../modules/auth/auth.service';
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
