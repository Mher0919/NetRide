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
    GOOGLE_ROUTES_API_KEY: zod_1.z.string().optional(),
    // ---- Routing engine: A* (PRIMARY) ----------------------------------------
    // Self-hosted A* routing engine. Loads preprocessed graph from disk.
    // Fast, free, and runs entirely in-memory. No external API calls.
    ROUTING_GRAPH_PATH: zod_1.z.string().optional(),
    // ---- Fallback routing engine: OSRM (self-hosted) -------------------------
    // Base URL of the self-hosted OSRM service (e.g. http://netride-osrm.internal:5000).
    // Used as fallback when A* engine is unavailable or graph not loaded.
    OSRM_BASE_URL: zod_1.z.string().optional(),
    // Per-request timeout to the local OSRM engine (ms).
    OSRM_TIMEOUT_MS: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).optional(),
    // Path on disk to the pre-processed OSRM road network (.osrm family).
    OSRM_DATA_PATH: zod_1.z.string().default('./data/la.osrm'),
    // ---- Fallback routing engine: OpenRouteService (ORS) --------------------
    // Get API key from https://openrouteservice.org/
    ORS_API_KEY: zod_1.z.string().optional(),
    ORS_PROFILE: zod_1.z.string().default('driving-car'),
    ORS_TIMEOUT_MS: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(8000),
    // ---- Dispatch Engine (v2) -----------------------------------------------
    // Initial preferred search radius (km). The engine starts here and expands
    // through secondary/max radii when no suitable driver is found.
    DISPATCH_INITIAL_RADIUS_KM: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(10),
    // Secondary search radius (km) — attempted when the initial radius yields
    // no eligible driver.
    DISPATCH_SECONDARY_RADIUS_KM: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(15),
    // Maximum search radius (km) — absolute ceiling before giving up.
    DISPATCH_MAX_RADIUS_KM: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(20),
    // How long (ms) a single driver offer stays valid before expiring.
    DRIVER_OFFER_TIMEOUT_MS: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(20000),
    // How long (seconds) a driver lock is held when reserved for a ride.
    DRIVER_LOCK_TTL_S: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(60),
    // Max seconds since last driver heartbeat for location to be considered fresh.
    DRIVER_LOCATION_FRESHNESS_S: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(60),
    // Threshold (seconds) for considering a driver "near completion" of their
    // current ride and thus eligible for a new dispatch offer.
    NEAR_COMPLETION_THRESHOLD_S: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(300),
    // Max number of candidate drivers to try per radius stage before expanding.
    MAX_CANDIDATES_PER_RADIUS: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(10),
    // ---- Legacy dispatch config ----------------------------------------------
    DRIVER_MATCH_RADIUS_KM: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(5),
    DRIVER_ACCEPT_TIMEOUT_MS: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(15000),
    DRIVER_PICKUP_PROXIMITY_M: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(15),
    DRIVER_DESTINATION_PROXIMITY_M: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(30),
    // Grace period: after this many seconds at pickup/dropoff, allow completion even if slightly outside strict proximity
    DRIVER_PROXIMITY_GRACE_S: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(30),
    // Wait timer: max seconds to wait for rider at pickup before driver can force-start
    DRIVER_WAIT_TIMER_S: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(120),
    // ---- Stale ride resolution (production watchdog) -------------------------
    // Accepted rides (driver assigned, rider never picked up) are dissolved
    // system-side when no `started_at` appears within this many seconds after
    // acceptance. Covers "driver killed the app" and abandoned pickups.
    RIDE_ACCEPT_STALL_S: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(900),
    // Hard ceiling for an in-progress ride: any ACTIVE ride whose journey has
    // run this long without completing is cancelled system-side (a real trip
    // never runs this long without a completion packet).
    RIDE_MAX_DURATION_S: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(28800),
    // Accepted rides sitting in ACCEPTED/DRIVER_ARRIVING that were never
    // started but were also never assigned a driver (orphaned REQUESTED rides
    // are handled by the existing REQUESTED sweep); NOT used for IN_PROGRESS.
    RIDE_STALL_SWEEP_BATCH: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(50),
    // ---- Face verification --------------------------------------------------
    GMAIL_CLIENT_ID: zod_1.z.string().optional(),
    GMAIL_CLIENT_SECRET: zod_1.z.string().optional(),
    GMAIL_REFRESH_TOKEN: zod_1.z.string().optional(),
    GMAIL_USER_EMAIL: zod_1.z.string().optional(),
    EMAIL_FROM: zod_1.z.string().default('NetRide <noreply@netride.com>'),
    ADMIN_NOTIFY_EMAIL: zod_1.z.string().default('support@netride.org'),
    APP_URL: zod_1.z.string().default('http://localhost:3000'),
    ADMIN_URL: zod_1.z.string().default('http://localhost:5173'),
    SUPABASE_URL: zod_1.z.string().optional(),
    SUPABASE_ANON_KEY: zod_1.z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: zod_1.z.string().optional(),
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
    // ---- Push notifications (FCM) -------------------------------------------
    // Path to Firebase service account JSON. If not set, push notifications
    // are logged but not actually sent (useful for development/testing).
    FCM_SERVICE_ACCOUNT_PATH: zod_1.z.string().optional(),
    // Alternatively, paste the JSON directly (base64-encoded for safety).
    FCM_SERVICE_ACCOUNT_B64: zod_1.z.string().optional(),
    // ---- Referral system ----------------------------------------------------
    // Secret used to sign referral QR payloads. MUST be stable across
    // restarts or every outstanding QR becomes invalid.
    REFERRAL_QR_SECRET: zod_1.z.string().default('netride-referral-dev-secret'),
    // Per-referral reward in cents (both sides, $5.00 default).
    REFERRAL_REWARD_CENTS: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(500),
    // Lifetime of a referral QR payload before the app must refresh it.
    REFERRAL_QR_TTL_DAYS: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(365),
    // ---- Sponsorship / SPECIALS ----------------------------------------------
    // How long a sponsor validation code stays valid after the ride completes.
    SPONSOR_CODE_TTL_HOURS: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(24),
    // Max failed validation-code entry attempts before the code is voided.
    SPONSOR_CODE_MAX_ATTEMPTS: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(5),
    // Radius (meters) around the sponsor location that counts as "visited".
    SPONSOR_PROXIMITY_M: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(100),
    // Rider credit reward when credits are chosen: D × SPONSOR_CREDIT_BONUS.
    // Default 1.10 → rider receives 110% of the sponsor-funded amount.
    SPONSOR_CREDIT_BONUS: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(1.10),
    // Driver share of the sponsor-funded discount (spec: 60% driver / 40% NetRide).
    SPONSOR_DRIVER_SHARE: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(0.60),
    // Whether sponsor-ledger writes are enforced strictly (unit tests disable).
    SPONSOR_LEDGER_ENFORCED: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform(Number).default(1),
});
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
    console.error('❌ Invalid environment variables:', parsed.error.format());
    process.exit(1);
}
exports.env = parsed.data;
//# sourceMappingURL=env.js.map