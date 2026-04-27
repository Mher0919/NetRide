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
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];

  // DEVELOPMENT BYPASS
  if (env.NODE_ENV === 'development' && token.startsWith('dummy-')) {
    const role = token.includes('driver') ? 'driver' : 'rider';
    req.user = {
      id: role === 'driver' ? '00000000-0000-0000-0000-000000000001' : '00000000-0000-0000-0000-000000000002',
      role: role,
      email: `${role}@uberish.dev`
    };
    console.log(`[AUTH] 🛠️ Dev bypass for ${role} via HTTP (Token: ${token})`);
    return next();
  }

  try {
    const decoded = AuthService.verifyToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};