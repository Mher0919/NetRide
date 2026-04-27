// backend/src/gateway/socket.middleware.ts
import { Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

/**
 * Socket.io middleware for JWT authentication.
 * Verifies the token provided in the handshake.
 */
export const socketAuthMiddleware = (socket: Socket, next: (err?: Error) => void) => {
  // Extract token from auth object or headers
  const token = socket.handshake.auth?.token || socket.handshake.headers['authorization']?.split(' ')[1];

  if (!token) {
    return next(new Error('Authentication error: Token missing'));
  }

  try {
    // DEV BYPASS: Allow dummy tokens in development
    if (env.NODE_ENV === 'development' && token.toString().startsWith('dummy-')) {
      const role = token.toString().includes('driver') ? 'driver' : 'rider';
      (socket as any).user = {
        id: `dev-${role}-id`,
        role: role
      };
      return next();
    }

    const decoded = jwt.verify(token as string, env.JWT_SECRET) as { id: string; role: string };
    
    // Attach user data to the socket object
    (socket as any).user = {
      id: decoded.id,
      role: decoded.role
    };
    
    next();
  } catch (err) {
    console.error('Socket auth error:', err);
    next(new Error('Authentication error: Invalid token'));
  }
};
