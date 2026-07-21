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
  // ---- Routing engine: OpenRouteService (ORS) -------------------------------
  // Used for all routing (replaces self-hosted OSRM).
  // Get API key from https://openrouteservice.org/
  ORS_API_KEY: z.string().optional(),
  ORS_PROFILE: z.string().default('driving-car'),
  ORS_TIMEOUT_MS: z.union([z.string(), z.number()]).transform(Number).default(8000),
  // ---- Local OSRM (legacy, for road-snapper nearest-node) -----------------
  // Base URL of the local OSRM osrm-routed server. Used by road-snapper for
  // nearest-node snapping. Optional — if not set, falls back to public OSRM.
  OSRM_BASE_URL: z.string().optional(),
  // Per-request timeout to the local OSRM engine (ms).
  OSRM_TIMEOUT_MS: z.union([z.string(), z.number()]).transform(Number).optional(),
  // Path on disk to the pre-processed OSRM road network (.osrm family).
  // Used by the startup script (start.sh / entrypoint) to find and launch
  // osrm-routed. Not read directly by backend code.
  OSRM_DATA_PATH: z.string().default('./data/la.osrm'),
  // ---- Fallback routing engine (Mapbox Directions API) --------------------
  // Used as fallback when ORS is unavailable.
  // The access token is never shipped to the Flutter app.
  MAPBOX_ACCESS_TOKEN: z.string().optional(),
  MAPBOX_PROFILE: z.string().default('driving'),
  MAPBOX_TIMEOUT_MS: z.union([z.string(), z.number()]).transform(Number).default(8000),
  DRIVER_MATCH_RADIUS_KM: z.union([z.string(), z.number()]).transform(Number).default(5),
  DRIVER_ACCEPT_TIMEOUT_MS: z.union([z.string(), z.number()]).transform(Number).default(15000),
  DRIVER_PICKUP_PROXIMITY_M: z.union([z.string(), z.number()]).transform(Number).default(15),
  DRIVER_DESTINATION_PROXIMITY_M: z.union([z.string(), z.number()]).transform(Number).default(30),

  // ---- Face verification --------------------------------------------------
  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),
  GMAIL_REFRESH_TOKEN: z.string().optional(),
  GMAIL_USER_EMAIL: z.string().optional(),
  EMAIL_FROM: z.string().default('NetRide <noreply@netride.com>'),
  ADMIN_NOTIFY_EMAIL: z.string().default('mmkrtumyan29@gmail.com'),
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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

