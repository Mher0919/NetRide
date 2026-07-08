"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.driverMiddleware = exports.riderMiddleware = exports.adminMiddleware = exports.authMiddleware = void 0;
const auth_service_1 = require("../modules/auth/auth.service");
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1];
    // If no token, return unauthorized
    if (!token) {
        console.warn(`[AUTH] ❌ No token provided for ${req.originalUrl}`);
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }
    try {
        const decoded = auth_service_1.AuthService.verifyToken(token);
        req.user = decoded;
        next();
    }
    catch (err) {
        console.error(`[AUTH] ❌ Verification failed for ${req.originalUrl}: ${err.message}`);
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
};
exports.authMiddleware = authMiddleware;
const adminMiddleware = (req, res, next) => {
    if (!req.user || req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Access denied. Administrator privileges required.' });
    }
    next();
};
exports.adminMiddleware = adminMiddleware;
const riderMiddleware = (req, res, next) => {
    if (!req.user || req.user.role !== 'RIDER') {
        return res.status(403).json({ error: 'Access denied. Rider account required.' });
    }
    next();
};
exports.riderMiddleware = riderMiddleware;
const driverMiddleware = (req, res, next) => {
    if (!req.user || req.user.role !== 'DRIVER') {
        return res.status(403).json({ error: 'Access denied. Driver account required.' });
    }
    next();
};
exports.driverMiddleware = driverMiddleware;
//# sourceMappingURL=auth.middleware.js.map