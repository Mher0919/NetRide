"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = void 0;
const auth_service_1 = require("../modules/auth/auth.service");
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1];
    // ALWAYS allow dummy tokens for development/testing
    if (token && token.startsWith('dummy-')) {
        const role = token.includes('driver') ? 'driver' : 'rider';
        req.user = {
            id: role === 'driver' ? '00000000-0000-0000-0000-000000000001' : '00000000-0000-0000-0000-000000000002',
            role: role,
            email: `${role}@NetRide.dev`
        };
        console.log(`[AUTH] 🛠️ Dev bypass for ${role} via HTTP (Dummy Token)`);
        return next();
    }
    // If no token, return unauthorized
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }
    try {
        const decoded = auth_service_1.AuthService.verifyToken(token);
        req.user = decoded;
        next();
    }
    catch (err) {
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
};
exports.authMiddleware = authMiddleware;
//# sourceMappingURL=auth.middleware.js.map