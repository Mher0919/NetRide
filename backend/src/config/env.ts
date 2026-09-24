// backend/src/config/env.ts
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.union([z.string(), z.number()]).transform(v => v.toString()).default('3000'),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string(),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  GOOGLE_ROUTES_API_KEY: z.string().optional(),
  // ---- Routing engine: A* (PRIMARY) ----------------------------------------
  // Self-hosted A* routing engine. Loads preprocessed graph from disk.
  // Fast, free, and runs entirely in-memory. No external API calls.
  ROUTING_GRAPH_PATH: z.string().optional(),
  // ---- Fallback routing engine: OSRM (self-hosted) -------------------------
  // Base URL of the self-hosted OSRM service (e.g. http://netride-osrm.internal:5000).
  // Used as fallback when A* engine is unavailable or graph not loaded.
  OSRM_BASE_URL: z.string().optional(),
  // Per-request timeout to the local OSRM engine (ms).
  OSRM_TIMEOUT_MS: z.union([z.string(), z.number()]).transform(Number).optional(),
  // Path on disk to the pre-processed OSRM road network (.osrm family).
  OSRM_DATA_PATH: z.string().default('./data/la.osrm'),
  // ---- Fallback routing engine: OpenRouteService (ORS) --------------------
  // Get API key from https://openrouteservice.org/
  ORS_API_KEY: z.string().optional(),
  ORS_PROFILE: z.string().default('driving-car'),
  ORS_TIMEOUT_MS: z.union([z.string(), z.number()]).transform(Number).default(8000),
  // ---- Dispatch Engine (v2) -----------------------------------------------
  // Initial preferred search radius (km). The engine starts here and expands
  // through secondary/max radii when no suitable driver is found.
  DISPATCH_INITIAL_RADIUS_KM: z.union([z.string(), z.number()]).transform(Number).default(10),
  // Secondary search radius (km) — attempted when the initial radius yields
  // no eligible driver.
  DISPATCH_SECONDARY_RADIUS_KM: z.union([z.string(), z.number()]).transform(Number).default(15),
  // Maximum search radius (km) — absolute ceiling before giving up.
  DISPATCH_MAX_RADIUS_KM: z.union([z.string(), z.number()]).transform(Number).default(20),
  // How long (ms) a single driver offer stays valid before expiring.
  DRIVER_OFFER_TIMEOUT_MS: z.union([z.string(), z.number()]).transform(Number).default(20000),
  // How long (seconds) a driver lock is held when reserved for a ride.
  DRIVER_LOCK_TTL_S: z.union([z.string(), z.number()]).transform(Number).default(60),
  // Max seconds since last driver heartbeat for location to be considered fresh.
  DRIVER_LOCATION_FRESHNESS_S: z.union([z.string(), z.number()]).transform(Number).default(60),
  // Threshold (seconds) for considering a driver "near completion" of their
  // current ride and thus eligible for a new dispatch offer.
  NEAR_COMPLETION_THRESHOLD_S: z.union([z.string(), z.number()]).transform(Number).default(300),
  // Max number of candidate drivers to try per radius stage before expanding.
  MAX_CANDIDATES_PER_RADIUS: z.union([z.string(), z.number()]).transform(Number).default(10),
  // ---- Legacy dispatch config ----------------------------------------------
  DRIVER_MATCH_RADIUS_KM: z.union([z.string(), z.number()]).transform(Number).default(5),
  DRIVER_ACCEPT_TIMEOUT_MS: z.union([z.string(), z.number()]).transform(Number).default(15000),
  DRIVER_PICKUP_PROXIMITY_M: z.union([z.string(), z.number()]).transform(Number).default(15),
  // Radius (meters) inside which a driver may complete the ride. 100m is
  // the practical drop-off zone: GPS accuracy + parking variance. The
  // driver app enables COMPLETE TRIP at the same 100m.
  DRIVER_DESTINATION_PROXIMITY_M: z.union([z.string(), z.number()]).transform(Number).default(100),
  // Grace period: after this many seconds at pickup/dropoff, allow completion even if slightly outside strict proximity
  DRIVER_PROXIMITY_GRACE_S: z.union([z.string(), z.number()]).transform(Number).default(30),
  // Wait timer: max seconds to wait for rider at pickup before driver can force-start
  DRIVER_WAIT_TIMER_S: z.union([z.string(), z.number()]).transform(Number).default(120),
  // ---- Stale ride resolution (production watchdog) -------------------------
  // Accepted rides (driver assigned, rider never picked up) are dissolved
  // system-side when no `started_at` appears within this many seconds after
  // acceptance. Covers "driver killed the app" and abandoned pickups.
  RIDE_ACCEPT_STALL_S: z.union([z.string(), z.number()]).transform(Number).default(900),
  // Hard ceiling for an in-progress ride: any ACTIVE ride whose journey has
  // run this long without completing is cancelled system-side (a real trip
  // never runs this long without a completion packet).
  RIDE_MAX_DURATION_S: z.union([z.string(), z.number()]).transform(Number).default(28800),
  // Accepted rides sitting in ACCEPTED/DRIVER_ARRIVING that were never
  // started but were also never assigned a driver (orphaned REQUESTED rides
  // are handled by the existing REQUESTED sweep); NOT used for IN_PROGRESS.
  RIDE_STALL_SWEEP_BATCH: z.union([z.string(), z.number()]).transform(Number).default(50),

  // ---- Face verification --------------------------------------------------
  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),
  GMAIL_REFRESH_TOKEN: z.string().optional(),
  GMAIL_USER_EMAIL: z.string().optional(),
  EMAIL_FROM: z.string().default('NetRide <support@netride.org>'),
  // Inbox for admin notifications + admin 2FA codes (support@netride.org
  // forwards to the ops Gmail).
  ADMIN_NOTIFY_EMAIL: z.string().default('support@netride.org'),
  APP_URL: z.string().default('http://localhost:3000'),
  ADMIN_URL: z.string().default('http://localhost:5173'),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_VERIFY_SERVICE_SID: z.string().optional(),
  // ---- Masked-call credentials (Programmable Voice + Client SDK) ----
  // The Voice Client SDK uses a separate API key/secret pair from the
  // account auth token. Twilio generates them under Account → API keys.
  TWILIO_API_KEY: z.string().optional(),
  TWILIO_API_SECRET: z.string().optional(),
  // TwiML App SID that points at our /api/ride/:id/call/connect endpoint
  // (returns <Client><Conference> TwiML when the SDK dials the app).
  TWILIO_TWIML_APP_SID: z.string().optional(),
  // Verified outbound caller ID for the conference bridge fallback.
  TWILIO_CALLER_ID: z.string().optional(),

  // ---- Navigation & safety -------------------------------------------------
  // Continuous over-limit seconds before a single speeding violation is
  // recorded on the current trip.
  SPEEDING_VIOLATION_DURATION_S: z.union([z.string(), z.number()]).transform(Number).default(45),
  // Distinct trips inside the window that contain a violation before the
  // driver is auto-flagged `is_dangerous = TRUE`.
  SPEEDING_DANGER_TRIP_COUNT: z.union([z.string(), z.number()]).transform(Number).default(3),
  // Window over which prior violations count toward the danger threshold.
  SPEEDING_WINDOW_DAYS: z.union([z.string(), z.number()]).transform(Number).default(90),
  // Distance from the planned polyline that counts as "off route" when
  // sustained for `SPEEDING_OFFROUTE_CONSECUTIVE_TICKS` consecutive GPS
  // updates. Triggers a single reroute per incident.
  NAV_OFFROUTE_THRESHOLD_M: z.union([z.string(), z.number()]).transform(Number).default(60),
  SPEEDING_OFFROUTE_CONSECUTIVE_TICKS: z.union([z.string(), z.number()]).transform(Number).default(3),

  // ---- Observability & scaling -------------------------------------------
  PINO_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SENTRY_DSN: z.string().optional(),
  MATCH_WORKER_CONCURRENCY: z.union([z.string(), z.number()]).transform(Number).default(4),
  DISPATCH_FANOUT_SIZE: z.union([z.string(), z.number()]).transform(Number).default(5),
  DRIVER_SCORE_CACHE_TTL_S: z.union([z.string(), z.number()]).transform(Number).default(300),

  // ---- Kill switches / legacy flags ---------------------------------------
  LOAD_TEST: z.enum(['true', 'false']).transform(v => v === 'true').default('false'),
  LEGACY_RATE_LIMIT: z.enum(['true', 'false']).transform(v => v === 'true').default('false'),
  LEGACY_SYNC_MATCHING: z.enum(['true', 'false']).transform(v => v === 'true').default('false'),
  LEGACY_SEQUENTIAL_DISPATCH: z.enum(['true', 'false']).transform(v => v === 'true').default('false'),
  LEGACY_DB_SCORE: z.enum(['true', 'false']).transform(v => v === 'true').default('false'),
  LEGACY_INLINE_PG: z.enum(['true', 'false']).transform(v => v === 'true').default('false'),
  DIRECT_DATABASE_URL: z.string().optional(),
  GEOAPIFY_API_KEY: z.string().optional(),
  DATABASE_REPLICA_URL: z.string().optional(),

  // ---- Push notifications (FCM) -------------------------------------------
  // Path to Firebase service account JSON. If not set, push notifications
  // are logged but not actually sent (useful for development/testing).
  FCM_SERVICE_ACCOUNT_PATH: z.string().optional(),
  // Alternatively, paste the JSON directly (base64-encoded for safety).
  FCM_SERVICE_ACCOUNT_B64: z.string().optional(),

  // ---- Referral system ----------------------------------------------------
  // Secret used to sign referral QR payloads. MUST be stable across
  // restarts or every outstanding QR becomes invalid.
  REFERRAL_QR_SECRET: z.string().default('netride-referral-dev-secret'),
  // Per-referral reward in cents (both sides, $5.00 default).
  REFERRAL_REWARD_CENTS: z.union([z.string(), z.number()]).transform(Number).default(500),
  // Lifetime of a referral QR payload before the app must refresh it.
  REFERRAL_QR_TTL_DAYS: z.union([z.string(), z.number()]).transform(Number).default(365),

  // ---- Sponsorship / SPECIALS ----------------------------------------------
  // How long a sponsor validation code stays valid after the ride completes.
  SPONSOR_CODE_TTL_HOURS: z.union([z.string(), z.number()]).transform(Number).default(24),
  // Max failed validation-code entry attempts before the code is voided.
  SPONSOR_CODE_MAX_ATTEMPTS: z.union([z.string(), z.number()]).transform(Number).default(5),
  // Radius (meters) around the sponsor location that counts as "visited".
  SPONSOR_PROXIMITY_M: z.union([z.string(), z.number()]).transform(Number).default(100),
  // Rider credit reward when credits are chosen: D × SPONSOR_CREDIT_BONUS.
  // Default 1.10 → rider receives 110% of the sponsor-funded amount.
  SPONSOR_CREDIT_BONUS: z.union([z.string(), z.number()]).transform(Number).default(1.10),
  // Driver share of the sponsor-funded discount (spec: 60% driver / 40% NetRide).
  SPONSOR_DRIVER_SHARE: z.union([z.string(), z.number()]).transform(Number).default(0.60),
  // Whether sponsor-ledger writes are enforced strictly (unit tests disable).
  SPONSOR_LEDGER_ENFORCED: z.union([z.string(), z.number()]).transform(Number).default(1),
  CORS_ORIGINS: z.string().optional(),
  SPONSOR_PORTAL_URL: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

