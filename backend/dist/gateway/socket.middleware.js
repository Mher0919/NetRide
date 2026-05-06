"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.socketAuthMiddleware = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../config/env");
/**
 * Socket.io middleware for JWT authentication.
 * Verifies the token provided in the handshake.
 */
const socketAuthMiddleware = (socket, next) => {
    // Extract token from auth object or headers
    const token = socket.handshake.auth?.token || socket.handshake.headers['authorization']?.split(' ')[1];
    if (!token) {
        return next(new Error('Authentication error: Token missing'));
    }
    try {
        // DEV BYPASS: Allow dummy tokens in development
        if (env_1.env.NODE_ENV === 'development' && token.toString().startsWith('dummy-')) {
            const role = token.toString().includes('driver') ? 'driver' : 'rider';
            socket.user = {
                id: role === 'driver' ? '00000000-0000-0000-0000-000000000001' : '00000000-0000-0000-0000-000000000002',
                role: role
            };
            return next();
        }
        const decoded = jsonwebtoken_1.default.verify(token, env_1.env.JWT_SECRET);
        // Attach user data to the socket object
        socket.user = {
            id: decoded.id,
            role: decoded.role
        };
        next();
    }
    catch (err) {
        console.error('Socket auth error:', err);
        next(new Error('Authentication error: Invalid token'));
    }
};
exports.socketAuthMiddleware = socketAuthMiddleware;
//# sourceMappingURL=socket.middleware.js.map