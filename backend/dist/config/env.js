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
    // Path to the baked regional OSRM road-network extract used by the
    // in-process engine (@osrm/osrm). Baked into the image at build time via
    // scripts/build-osrm.sh (Los Angeles County by default — light & fast).
    OSRM_DATA_PATH: zod_1.z.string().default('./data/la.osrm'),
    DRIVER_MATCH_RADIUS_KM: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(5),
    DRIVER_ACCEPT_TIMEOUT_MS: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(15000),
    DRIVER_PICKUP_PROXIMITY_M: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(15),
    DRIVER_DESTINATION_PROXIMITY_M: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(30),
    // ---- Face verification --------------------------------------------------
    GMAIL_CLIENT_ID: zod_1.z.string().optional(),
    GMAIL_CLIENT_SECRET: zod_1.z.string().optional(),
    GMAIL_REFRESH_TOKEN: zod_1.z.string().optional(),
    GMAIL_USER_EMAIL: zod_1.z.string().optional(),
    EMAIL_FROM: zod_1.z.string().default('NetRide <noreply@netride.com>'),
    ADMIN_NOTIFY_EMAIL: zod_1.z.string().default('mmkrtumyan29@gmail.com'),
    APP_URL: zod_1.z.string().default('http://localhost:3000'),
    ADMIN_URL: zod_1.z.string().default('http://localhost:5173'),
    SUPABASE_URL: zod_1.z.string().optional(),
    SUPABASE_ANON_KEY: zod_1.z.string().optional(),
    TWILIO_ACCOUNT_SID: zod_1.z.string().optional(),
    TWILIO_AUTH_TOKEN: zod_1.z.string().optional(),
    TWILIO_VERIFY_SERVICE_SID: zod_1.z.string().optional(),
    // ---- Masked-call credentials (Programmable Voice + Client SDK) ----
    // The Voice Client SDK uses a separate API key/secret pair from the
    // account auth token. Twilio generates them under Account → API keys.
    TWILIO_API_KEY: zod_1.z.string().optional(),
    TWILIO_API_SECRET: zod_1.z.string().optional(),
    // TwiML App SID that points at our /api/ride/:id/call/connect endpoint
    // (returns <Client><Conference> TwiML when the SDK dials the app).
    TWILIO_TWIML_APP_SID: zod_1.z.string().optional(),
    // Verified outbound caller ID for the conference bridge fallback.
    TWILIO_CALLER_ID: zod_1.z.string().optional(),
    // ---- Navigation & safety -------------------------------------------------
    // Continuous over-limit seconds before a single speeding violation is
    // recorded on the current trip.
    SPEEDING_VIOLATION_DURATION_S: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(45),
    // Distinct trips inside the window that contain a violation before the
    // driver is auto-flagged `is_dangerous = TRUE`.
    SPEEDING_DANGER_TRIP_COUNT: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(3),
    // Window over which prior violations count toward the danger threshold.
    SPEEDING_WINDOW_DAYS: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(90),
    // Distance from the planned polyline that counts as "off route" when
    // sustained for `SPEEDING_OFFROUTE_CONSECUTIVE_TICKS` consecutive GPS
    // updates. Triggers a single reroute per incident.
    NAV_OFFROUTE_THRESHOLD_M: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(60),
    SPEEDING_OFFROUTE_CONSECUTIVE_TICKS: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(3),
    // ---- Observability & scaling -------------------------------------------
    PINO_LOG_LEVEL: zod_1.z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    SENTRY_DSN: zod_1.z.string().optional(),
    // Comma-separated OSRM URLs for the internal load balancer. Falls back
    // to single OSRM_URL when unset so the dev docker-compose keeps working.
    OSRM_URLS: zod_1.z.string().optional(),
    MATCH_WORKER_CONCURRENCY: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(4),
    DISPATCH_FANOUT_SIZE: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(5),
    DRIVER_SCORE_CACHE_TTL_S: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(300),
    // ---- Kill switches / legacy flags ---------------------------------------
    LOAD_TEST: zod_1.z.enum(['true', 'false']).transform(v => v === 'true').default('false'),
    LEGACY_RATE_LIMIT: zod_1.z.enum(['true', 'false']).transform(v => v === 'true').default('false'),
    LEGACY_SYNC_MATCHING: zod_1.z.enum(['true', 'false']).transform(v => v === 'true').default('false'),
    LEGACY_SEQUENTIAL_DISPATCH: zod_1.z.enum(['true', 'false']).transform(v => v === 'true').default('false'),
    LEGACY_DB_SCORE: zod_1.z.enum(['true', 'false']).transform(v => v === 'true').default('false'),
    LEGACY_INLINE_PG: zod_1.z.enum(['true', 'false']).transform(v => v === 'true').default('false'),
    DIRECT_DATABASE_URL: zod_1.z.string().optional(),
    GEOAPIFY_API_KEY: zod_1.z.string().optional(),
    DATABASE_REPLICA_URL: zod_1.z.string().optional(),
});
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
    console.error('❌ Invalid environment variables:', parsed.error.format());
    process.exit(1);
}
exports.env = parsed.data;
//# sourceMappingURL=env.js.map