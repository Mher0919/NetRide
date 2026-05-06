"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
// backend/src/config/env.ts
const dotenv_1 = __importDefault(require("dotenv"));
const zod_1 = require("zod");
dotenv_1.default.config();
const envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(['development', 'production', 'test']).default('development'),
    PORT: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(v => v.toString()).default('3000'),
    DATABASE_URL: zod_1.z.string(),
    REDIS_URL: zod_1.z.string().default('redis://localhost:6379'),
    JWT_SECRET: zod_1.z.string(),
    GOOGLE_MAPS_API_KEY: zod_1.z.string().optional(),
    OSRM_URL: zod_1.z.string().default('http://localhost:5000/route/v1/driving'),
    DRIVER_MATCH_RADIUS_KM: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(5),
    DRIVER_ACCEPT_TIMEOUT_MS: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(15000),
    GMAIL_CLIENT_ID: zod_1.z.string().optional(),
    GMAIL_CLIENT_SECRET: zod_1.z.string().optional(),
    GMAIL_REFRESH_TOKEN: zod_1.z.string().optional(),
    GMAIL_USER_EMAIL: zod_1.z.string().optional(),
    EMAIL_FROM: zod_1.z.string().default('NetRide <noreply@netride.com>'),
    APP_URL: zod_1.z.string().default('http://localhost:3000'),
});
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
    console.error('❌ Invalid environment variables:', parsed.error.format());
    process.exit(1);
}
exports.env = parsed.data;
//# sourceMappingURL=env.js.map