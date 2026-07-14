import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../modules/auth/auth.service';

export const identifyUser = (req: Request, _res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return next();

  const token = authHeader.split(' ')[1];
  if (!token) return next();

  try {
    const decoded = AuthService.verifyToken(token);
    (req as any).user = decoded;
  } catch {
    // Token invalid or expired — continue without user context
  }

  next();
};
