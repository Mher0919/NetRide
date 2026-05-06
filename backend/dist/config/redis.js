"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DRIVER_LOCATIONS_KEY = exports.redis = void 0;
// backend/src/config/redis.ts
const ioredis_1 = __importDefault(require("ioredis"));
const env_1 = require("./env");
// If REDIS_URL contains 'localhost', replace with '127.0.0.1' for Windows reliability
const redisUrl = env_1.env.REDIS_URL.replace('localhost', '127.0.0.1');
exports.redis = new ioredis_1.default(redisUrl, {
    maxRetriesPerRequest: null,
    connectTimeout: 5000, // 5 seconds
});
exports.redis.on('error', (err) => {
    console.error('[REDIS] Connection error:', err.message);
});
exports.redis.on('connect', () => {
    console.log('[REDIS] Successfully connected to Redis at', redisUrl);
});
exports.DRIVER_LOCATIONS_KEY = 'driver_locations';
//# sourceMappingURL=redis.js.map