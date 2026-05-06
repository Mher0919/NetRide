import { Socket } from 'socket.io';
/**
 * Socket.io middleware for JWT authentication.
 * Verifies the token provided in the handshake.
 */
export declare const socketAuthMiddleware: (socket: Socket, next: (err?: Error) => void) => void;
