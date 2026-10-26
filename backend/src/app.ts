// backend/src/app.ts
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { env } from './config/env';
import { pool } from './config/database';
import { redis } from './config/redis';
import { AuthService } from './modules/auth/auth.service';
import { setupSocketGateway } from './gateway/socket.gateway';
import { rateLimitMiddleware } from './middleware/rateLimit.middleware';
import { identifyUser } from './middleware/identifyUser.middleware';
import { authMiddleware } from './middleware/auth.middleware';
import { attachPrivateFileAccessTokens } from './middleware/fileAccessToken.middleware';
import { enforceAppVersion } from './middleware/appVersion.middleware';
import { initSentry } from './observability/sentry';
import { logger } from './observability/logger';
import { requestContext, requestLogger } from './middleware/pinoHttp';
import { jsonShapeGuard } from './middleware/jsonShapeGuard.middleware';
import { securityHeaders } from './middleware/securityHeaders.middleware';
import healthRouter from './health/health.controller';
import fileRoutes from './routes/files.routes';
import { register } from './observability/metrics';

// Sentry must initialize before any other module that may throw at
// import time so it can capture those errors.
initSentry();

// Safety net: a stray rejected promise (e.g. a queued Redis command when
// Redis is down at boot) must never take down the whole API. Log it and
// keep serving — the affected subsystem degrades and recovers on its own.
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error(`[PROCESS] ⚠️ Unhandled promise rejection (non-fatal): ${message}`);
});

// Route Imports
import authRoutes from './modules/auth/auth.routes';
import userRoutes from './modules/user/user.routes';
import driverRoutes from './modules/driver/driver.routes';
import rideRoutes from './modules/ride/ride.routes';
import geospatialRoutes from './modules/geospatial/geospatial.routes';
import navigationRoutes from './modules/navigation/navigation.routes';
import routingRoutes from './modules/routing/routing.routes';
import adminRoutes from './modules/admin/admin.routes';
import adminRewardsRoutes from './modules/admin/admin-rewards.routes';
import creditsRoutes from './modules/credits/credits.routes';
import promoRoutes from './modules/promo/promo.routes';
import referralRoutes from './modules/referral/referral.routes';
import walletRoutes from './modules/wallet/wallet.routes';
import routingApi from './routing/api/routing-api';
import pushRoutes from './modules/push/push.routes';
import placesRoutes from './modules/places/places.routes';
import googlePlacesRoutes from './modules/google-places/google-places.routes';
import notificationsRoutes from './modules/notifications/notifications.routes';
import heatmapRoutes from './modules/heatmap/heatmap.routes';
import specialsRoutes from './modules/sponsor/specials.routes';
import sponsorPortalRoutes from './modules/sponsor/sponsor-portal.routes';
import adminSponsorRoutes from './modules/sponsor/admin-sponsor.routes';
import partnerPortalRoutes from './modules/partner/partner-portal.routes';
import portalRoutes from './modules/portal/portal.routes';
import paymentsRoutes from './modules/payments/payments.routes';
import adminPaymentsRoutes from './modules/payments/admin-payments.routes';
import appVersionRoutes from './modules/app-version/app-version.routes';
import appUpdateAdminRoutes from './modules/app-version/app-update.admin.routes';
import { getReleaseConfig } from './modules/app-version/app-version.service';
import {
  APP_IDS,
  APP_PLATFORMS,
  AppId,
  AppPlatform,
  evaluateVersion,
  isValidVersion,
  parseVersion,
} from './modules/app-version/app-version.utils';
import { PaymentsController as StripeWebhookController } from './modules/payments/payments.controller';
import { SpecialRedemptionService } from './modules/sponsor/special-redemption.service';
import { RideSettlementService } from './modules/payments/ride-settlement.service';
import { GeospatialService } from './modules/geospatial/geospatial.service';
import { UploadService } from './services/upload.service';
import { SpeedingDetector } from './services/speeding_detector';
import { trajectoryEvents } from './modules/location/locations.service';

const app = express();
// Baseline security headers for every response. The API never serves
// documents, so a locked-down CSP costs nothing and neutralizes accidental
// HTML reflection; X-Frame-Options/Referrer-Policy protect the Stripe
// return pages from clickjacking and referrer leakage; HSTS is emitted only
// when the request arrived over TLS.
app.use(securityHeaders);
// API responses must never be revalidated from the browser's HTTP cache:
// Express's default weak ETag + browser revalidation turned every admin
// dashboard poll into a 304 "not modified" replay of a stale cached ride
// list — the dashboard kept showing an empty/old state no matter what the
// DB said. A live operational dashboard reads current truth on every poll.
app.disable('etag');
app.disable('x-powered-by');
// Belt-and-braces: private, uncacheable for all admin/monitoring responses.
app.use('/api/admin', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
const httpServer = createServer(app);
// Explicit allowlist ONLY when the operator configures CORS_ORIGINS.
// Without it, all origins are accepted — the pre-regression behavior that
// the deployed dashboards (admin-dashboard.netride.org, sponsor portal,
// local dev on any port) depend on. Auth is bearer-token based
// (localStorage), never cookies, so an open CORS policy does not expose
// credentials to third-party origins.
const corsOrigins = env.CORS_ORIGINS
  ? env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : [];
const isAllowedOrigin = (origin: string): boolean => {
  if (corsOrigins.length === 0 || corsOrigins.includes(origin)) return true;
  // Local dev origins stay usable even against a strictly-configured backend.
  try {
    const host = new URL(origin).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return true;
  } catch {
    return false;
  }
  return false;
};
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || isAllowedOrigin(origin)) callback(null, true);
      else callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  // Explicit payload cap (Socket.IO's default, made intentional): socket
  // events carry small JSON envelopes; anything larger is abuse.
  maxHttpBufferSize: 1_000_000,
});

// Step 10: Socket.IO redis adapter for multi-instance support.
// Uses separate pub/sub clients so regular Redis commands don't
// conflict with socket message broadcasting.
import { createAdapter } from '@socket.io/redis-adapter';
import { pubClient, subClient } from './config/redisPubSub';
import { bindIo } from './gateway/io-handle';
try {
  io.adapter(createAdapter(pubClient, subClient));
} catch (adapterErr: any) {
  console.warn(`[SERVER] ⚠️ Socket.IO Redis adapter failed (non-fatal): ${adapterErr.message}`);
  console.warn('[SERVER] ⚠️ Multi-instance Socket.IO scaling disabled. Running in single-instance mode.');
}

// Publish the authoritative io handle so service modules can depend on a
// lazy binding instead of importing this file (which would evaluate the
// whole app — including its HTTP listener — inside worker processes).
bindIo(io);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-portal-type',
    'X-App-Id',
    'X-App-Platform',
    'X-App-Version',
    'X-App-Build',
    'X-Device-Id',
  ],
}));
// Trust Render proxy so req.ip resolves individual client IPs
// instead of the proxy IP. This fixes rate-limit key collisions
// where all users share one rate-limit bucket behind Render.
app.set('trust proxy', 1);
// Stripe webhook FIRST: signature verification needs the raw request bytes,
// so this route must be registered before the global JSON body parser. The
// handler verifies the signature with Stripe's official library using
// STRIPE_WEBHOOK_SECRET. No auth middleware — Stripe authenticates by
// signature.
app.post(
  '/api/payments/webhook',
  express.raw({ type: 'application/json', limit: '2mb' }),
  StripeWebhookController.webhook,
);
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ limit: '8mb', extended: true }));
// The byte limit above does not bound element counts: an 8 MB array of
// invalid values would make zod allocate one issue object per element and
// OOM the process (CVE-2023-54404 class). Reject absurd shapes before any
// route/schema sees them.
app.use(jsonShapeGuard());
// Request-id + child logger context. Mount BEFORE rate-limit so even
// 429s get a log line and a metric.
app.use(requestContext);
app.use(requestLogger);
// Optional auth — extracts user from JWT if present (no rejection).
// Must run BEFORE rate-limit so authenticated requests use user-based keys.
app.use(identifyUser);
app.use(rateLimitMiddleware);
app.use(enforceAppVersion);
// Admin JSON responses may embed private document references; this mints
// short-lived, purpose-scoped access tokens for the authenticated admin
// (public profile photos are left untouched). MUST run after identifyUser so
// req.user is populated.
app.use('/api/admin', attachPrivateFileAccessTokens);

// NOTE: the old anonymous `express.static` mount on /uploads was removed.
// Every stored file must pass the resource-level authorization in
// /api/files/:id — a static mount bypasses it entirely.

// Backwards-compatible health endpoint (same shape as before).
// New load-balancer-friendly endpoints live at /health/live and
// /health/ready (see health.controller.ts).
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'OK', database: 'connected' });
  } catch (err: any) {
    logger.error({ err: err.message }, 'health_check_db_failed');
    res.status(500).json({
      status: 'ERROR',
      database: 'disconnected',
      message: err.message
    });
  }
});

app.use(healthRouter);

// Prometheus scrape endpoint. Exposed unauthenticated on the assumption
// the network policy (or reverse proxy) restricts it to the metrics scraper.
app.get('/metrics', async (_req, res) => {
  res.setHeader('Content-Type', register.contentType);
  res.send(await register.metrics());
});

// Diagnostic Ping
app.get('/api/ping', (req, res) => {
  res.json({ status: 'pong', time: new Date().toISOString() });
});

// Connection-level throttle: a handshake is expensive (JWT verification +
// two identity lookups + presence write + per-connection timer), so a single
// source cannot open connections without bound. Shared across instances via
// Redis; fails open on Redis outages (mirrors the HTTP limiter) so a cache
// outage can never take real-time down.
const SOCKET_CONN_LIMIT = { max: 30, windowMs: 60 * 1000 };
async function socketHandshakeAllowed(ip: string): Promise<boolean> {
  try {
    const key = `socket_conn:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.pexpire(key, SOCKET_CONN_LIMIT.windowMs);
    return count <= SOCKET_CONN_LIMIT.max;
  } catch (err: any) {
    console.warn(`[AUTH] socket connection throttle unavailable: ${err.message}`);
    return true;
  }
}

// Middleware for Socket.io auth
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.headers.authorization;

  if (!token) {
    return next(new Error('Authentication error: No token provided'));
  }

  const remoteIp = socket.handshake.address || 'unknown';
  if (!(await socketHandshakeAllowed(remoteIp))) {
    console.warn(`[AUTH] ❌ Socket connection throttle exceeded for ${remoteIp}`);
    return next(new Error('Authentication error: Too many connection attempts'));
  }

  try {
    const pureToken = token.toString().replace('Bearer ', '');
    const decoded = AuthService.verifyToken(pureToken);

    // Reject tokens of deactivated users / demoted admins / pre-password-
    // change sessions immediately (fails closed on lookup errors).
    await AuthService.assertTokenStillValid(decoded);

    const appIdRaw = String(socket.handshake.auth.appId ?? '')
      .trim()
      .toLowerCase();
    const platformRaw = String(socket.handshake.auth.platform ?? '')
      .trim()
      .toLowerCase();
    const appVersion = String(socket.handshake.auth.version ?? '').trim();
    if (
      appIdRaw &&
      platformRaw &&
      appVersion &&
      (APP_IDS as readonly string[]).includes(appIdRaw) &&
      (APP_PLATFORMS as readonly string[]).includes(platformRaw) &&
      parseVersion(appVersion)
    ) {
      try {
        const config = await getReleaseConfig(
          appIdRaw as AppId,
          platformRaw as AppPlatform,
        );
        const buildRaw = String(socket.handshake.auth.build ?? '').trim();
        const appBuild = /^\d+$/.test(buildRaw) ? Number(buildRaw) : null;
        if (
          config.isActive &&
          config.campaignStatus === 'PUBLISHED' &&
          isValidVersion(config.minimumVersion) &&
          evaluateVersion(config, appVersion, appBuild).updateRequired
        ) {
          return next(new Error('APP_UPDATE_REQUIRED'));
        }
      } catch (error: any) {
        console.error(
          `[APP-VERSION] Socket enforcement skipped: ${error.message}`,
        );
      }
    }

    // Resolve the ACTIVE session role from the application context supplied
    // by the connecting client (e.g. the Driver App sends `role: 'driver'`,
    // the Rider App sends `role: 'rider'`). This is the single source of
    // truth for which "hat" the user is wearing during this connection and
    // MUST NOT be inferred from the frozen `users.role` column alone. A
    // dual-role user (same email owning both profiles) is identified by the
    // app they launched, never by account-existence order.
    //
    // Fails CLOSED: if the live profile cannot be resolved (DB blip), the
    // connection is refused rather than silently granting the stale JWT
    // role-claim — an attacker cannot win access by inducing DB errors.
    const appRoleHint = socket.handshake.auth.role;
    const active = await AuthService.resolveActiveRole(decoded.id, appRoleHint);

    (socket as any).user = {
      id: decoded.id,
      // Active application/session role — used for all downstream branching,
      // logging, presence, and ride-matching.
      role: active.role,
      // The role carried in the JWT claim (legacy/frozen `users.role`). Kept
      // for reference only; `role` above is authoritative for this session.
      jwtRole: decoded.role,
      driverId: active.driverId,
      riderId: active.riderId,
      // Stable per-connection session id for tracing/logging.
      sessionId: socket.id,
    };
    next();
  } catch (err: any) {
    console.error(`[AUTH] ❌ Socket JWT verification failed:`, err.message);
    return next(new Error('Authentication error: Invalid token'));
  }
});

// Initialize Gateway
setupSocketGateway(io);

// Mount Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/driver', driverRoutes);
app.use('/api/ride', rideRoutes);
app.use('/api/geospatial', geospatialRoutes);
app.use('/api/navigation', navigationRoutes);
app.use('/api/routing', routingRoutes);
app.use('/api/routing', routingApi);
app.use('/api/admin', appUpdateAdminRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin', adminRewardsRoutes);
app.use('/api/app', appVersionRoutes);
app.use('/api/credits', creditsRoutes);
app.use('/api/promo', promoRoutes);
app.use('/api/referral', referralRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/places', placesRoutes);
app.use('/api', googlePlacesRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/heatmap', heatmapRoutes);
app.use('/api', specialsRoutes);
app.use('/api', sponsorPortalRoutes);
app.use('/api/partner', partnerPortalRoutes);
app.use('/api', portalRoutes);
app.use('/api/admin', adminSponsorRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/admin/payments', adminPaymentsRoutes);
// Uploads require an authenticated identity: the owner of the file is taken
// from the verified token, never from the request body.
app.post('/api/upload', authMiddleware, UploadService.upload);

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[SERVER] 💥 Unhandled Error:', err);
  
  // Don't expose internal error details in production-like responses
  res.status(err.status || 500).json({
    error: 'An unexpected error occurred on our end. Our team has been notified.'
  });
});

async function runMigrations() {
  try {
    // Initial Schema
    const ridesTable = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'rides'");
    if (ridesTable.rowCount === 0) {
      console.log('⚡ Initializing database schema (001)...');
      const schemaPath = path.join(__dirname, '../migrations/001_initial_schema.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Initial schema (001) initialized successfully');
    }

    // Verification Schema
    const otpTable = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'verification_codes'");
    if (otpTable.rowCount === 0) {
      console.log('⚡ Initializing verification schema (002)...');
      const schemaPath = path.join(__dirname, '../migrations/002_auth_verification.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Verification schema (002) initialized successfully');
    }

    // OTP code hashing + attempt capping (048).
    const hasOtpCodeHash = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'verification_codes' AND column_name = 'code_hash'"
    );
    if (hasOtpCodeHash.rowCount === 0) {
      console.log('⚡ Applying OTP code hashing schema (048)...');
      const schemaPath = path.join(__dirname, '../migrations/048_otp_code_hashing.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ OTP code hashing schema (048) applied');
    }

    // Fix User Schema
    const hasPasswordHash = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'password_hash'");
    if (hasPasswordHash.rowCount === 0) {
      console.log('⚡ Patching user schema (003)...');
      const schemaPath = path.join(__dirname, '../migrations/003_fix_user_schema.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ User schema patched successfully');
    }

    // Add License Back Photo
    const hasLicenseBack = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'drivers' AND column_name = 'license_photo_back_url'");
    if (hasLicenseBack.rowCount === 0) {
      console.log('⚡ Patching driver schema (004)...');
      const schemaPath = path.join(__dirname, '../migrations/004_add_license_back_photo.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Driver schema (004) patched successfully');
    }

    // Add Insurance/Registration
    const hasInsurance = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'drivers' AND column_name = 'insurance_photo_url'");
    if (hasInsurance.rowCount === 0) {
      console.log('⚡ Patching driver schema (005)...');
      const schemaPath = path.join(__dirname, '../migrations/005_add_insurance_registration.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Driver schema (005) patched successfully');
    }

    // Add Is Active to Users
    const hasIsActive = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'is_active'");
    if (hasIsActive.rowCount === 0) {
      console.log('⚡ Patching user schema (006)...');
      const schemaPath = path.join(__dirname, '../migrations/006_add_is_active_to_users.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ User schema (006) patched successfully');
    }

    // Add Ratings and Moving Average
    const hasRating = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'rating'");
    if (hasRating.rowCount === 0) {
      console.log('⚡ Patching ratings schema (007)...');
      const schemaPath = path.join(__dirname, '../migrations/007_add_ratings_and_moving_average.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Ratings schema (007) patched successfully');
    }

    // Add Vehicle Models
    const hasVehicleModels = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'vehicle_models'");
    if (hasVehicleModels.rowCount === 0) {
      console.log('⚡ Patching vehicle models schema (008)...');
      const schemaPath = path.join(__dirname, '../migrations/008_add_vehicle_models.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Vehicle models schema (008) patched successfully');
    }

    // Add Admin and Audit Logs
    const hasAuditLogs = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_logs'");
    if (hasAuditLogs.rowCount === 0) {
      console.log('⚡ Patching admin schema (009)...');
      const schemaPath = path.join(__dirname, '../migrations/009_admin_and_audit_logs.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Admin schema (009) patched successfully');
    }

    // Add ID Photos to users (010)
    const hasUserIdPhotos = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'id_photo_front_url'");
    if (hasUserIdPhotos.rowCount === 0) {
      console.log('⚡ Patching user schema (010)...');
      const schemaPath = path.join(__dirname, '../migrations/010_add_user_id_photos.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ User schema (010) patched successfully');
    }

    // Add Password Expiration (011)
    const hasPasswordChangedAt = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'password_changed_at'");
    if (hasPasswordChangedAt.rowCount === 0) {
      console.log('⚡ Patching user schema (011)...');
      const schemaPath = path.join(__dirname, '../migrations/011_add_password_expiration.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ User schema (011) patched successfully');
    }

    // Upgrade Ride Schema (012)
    const hasTrajectory = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'rides' AND column_name = 'trajectory'");
    if (hasTrajectory.rowCount === 0) {
      console.log('⚡ Patching ride schema (012)...');
      const schemaPath = path.join(__dirname, '../migrations/012_upgrade_ride_schema.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Ride schema (012) patched successfully');
    }

    // Upgrade Vehicle Classes (013)
    const hasServiceClass = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'vehicles' AND column_name = 'service_class'");
    if (hasServiceClass.rowCount === 0) {
      console.log('⚡ Patching vehicle classes schema (013)...');
      const schemaPath = path.join(__dirname, '../migrations/013_upgrade_vehicle_classes.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Vehicle classes schema (013) patched successfully');
    }

    // Add Vehicle Inspection and Compliance Snapshot (014)
    const hasComplianceSnapshot = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'rides' AND column_name = 'compliance_snapshot'");
    if (hasComplianceSnapshot.rowCount === 0) {
      console.log('⚡ Patching compliance schema (014)...');
      const schemaPath = path.join(__dirname, '../migrations/014_add_vehicle_inspection_and_compliance.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Compliance schema (014) patched successfully');
    }

    // Add Favorites, Scheduling, and Tipping (015)
    const hasFavoriteDrivers = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'favorite_drivers'");
    if (hasFavoriteDrivers.rowCount === 0) {
      console.log('⚡ Patching features schema (015)...');
      const schemaPath = path.join(__dirname, '../migrations/015_add_favorites_scheduling_tipping.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Features schema (015) patched successfully');
    }

    // Enable RLS and Policies (016)
    // Check if RLS is enabled on 'users' table as a proxy for this migration
    const isRlsEnabled = await pool.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'users'");
    if (isRlsEnabled.rows[0]?.relrowsecurity === false) {
      console.log('⚡ Securing database with RLS and Policies (016)...');
      const schemaPath = path.join(__dirname, '../migrations/016_enable_rls_and_policies.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Database security (016) applied successfully');
    }

    // Navigation + safety schema (019): route_metadata on rides and
    // the speeding_violations ledger for the dangerous-driver flag.
    const hasRouteMetadata = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'rides' AND column_name = 'route_metadata'");
    if (hasRouteMetadata.rowCount === 0) {
      console.log('⚡ Patching navigation + safety schema (019)...');
      const schemaPath = path.join(__dirname, '../migrations/019_navigation_safety.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Navigation + safety schema (019) applied successfully');
    }

    // Profile-change approval + wallet + payouts (020).
    const hasProfileChangeRequests = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'profile_change_requests'");
    if (hasProfileChangeRequests.rowCount === 0) {
      console.log('⚡ Patching profile-change + wallet + payouts schema (020)...');
      const schemaPath = path.join(__dirname, '../migrations/020_profile_changes_wallet_payouts.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Profile-change + wallet + payouts schema (020) applied successfully');
    }

    // Scaling indexes (021).
    const hasIdxDriversActive = await pool.query(
      "SELECT 1 FROM pg_indexes WHERE indexname = 'idx_drivers_active_class'"
    );
    if (hasIdxDriversActive.rowCount === 0) {
      console.log('⚡ Applying scaling indexes (021)...');
      const schemaPath = path.join(__dirname, '../migrations/021_scaling_indexes.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Scaling indexes (021) applied');
    }

    // Onboarding step tracking + phone verification flag + plate state + zip (022).
    const hasOnboardingStep = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'onboarding_step'"
    );
    if (hasOnboardingStep.rowCount === 0) {
      console.log('⚡ Applying onboarding + phone fields schema (022)...');
      const schemaPath = path.join(__dirname, '../migrations/022_onboarding_phone_fields.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Onboarding + phone fields schema (022) applied');
    }

    // Driver-specific phone number + phone_verified columns (023).
    const hasDriverPhoneColumn = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'drivers' AND column_name = 'phone_number'"
    );
    if (hasDriverPhoneColumn.rowCount === 0) {
      console.log('⚡ Adding driver-specific phone columns (023)...');
      const schemaPath = path.join(__dirname, '../migrations/023_driver_phone_separate.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Driver phone columns (023) applied');
    }

    // Document resubmission requirements (024).
    const hasDocRequirements = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'driver_document_requirements'"
    );
    if (hasDocRequirements.rowCount === 0) {
      console.log('⚡ Applying document resubmissions schema (024)...');
      const schemaPath = path.join(__dirname, '../migrations/024_document_resubmissions.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Document resubmissions schema (024) applied');
    }

    // Vehicle submissions + pending-review status (025).
    const hasVehicleSubmissions = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'driver_vehicle_submissions'"
    );
    if (hasVehicleSubmissions.rowCount === 0) {
      console.log('⚡ Applying vehicle submissions schema (025)...');
      const schemaPath = path.join(__dirname, '../migrations/025_vehicle_submissions.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Vehicle submissions schema (025) applied');
    }

    // Vehicle active vehicle + resubmission workflow (026).
    const hasVehicleResubmission = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'driver_vehicle_resubmission_requests'"
    );
    if (hasVehicleResubmission.rowCount === 0) {
      console.log('⚡ Applying vehicle active + resubmission schema (026)...');
      const schemaPath = path.join(__dirname, '../migrations/026_vehicle_active_and_resubmission.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Vehicle active + resubmission schema (026) applied');
    }

    // DOB locked column (027).
    const hasDobLocked = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'dob_locked'"
    );
    if (hasDobLocked.rowCount === 0) {
      console.log('⚡ Applying DOB locked schema (027)...');
      const schemaPath = path.join(__dirname, '../migrations/027_add_dob_locked.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ DOB locked schema (027) applied');
    }

    // Storage files table (028) — permanent file references.
    const hasStorageFiles = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'storage_files'"
    );
    if (hasStorageFiles.rowCount === 0) {
      console.log('⚡ Applying storage_files schema (028)...');
      const schemaPath = path.join(__dirname, '../migrations/028_storage_files.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Storage files schema (028) applied');
    }

    // Make audit_logs.admin_id nullable (029). System-generated events
    // (no acting admin) can be recorded, so the column must allow NULL.
    // Guards on the column's current nullability.
    const adminIdNullable = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_logs' AND column_name = 'admin_id' AND is_nullable = 'YES'"
    );
    if (adminIdNullable.rowCount === 0) {
      console.log('⚡ Relaxing audit_logs.admin_id nullability (029)...');
      const schemaPath = path.join(__dirname, '../migrations/029_audit_logs_admin_nullable.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ audit_logs.admin_id made nullable');
    }

    // User block + rating flag (030)
    const hasBlockedReason = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'blocked_reason'");
    if (hasBlockedReason.rowCount === 0) {
      console.log('⚡ Applying user block + rating flag schema (030)...');
      const schemaPath = path.join(__dirname, '../migrations/030_user_block_and_rating_flag.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ User block + rating flag schema (030) applied');
    }

    // Vehicle classification + driver ride preferences (031)
    const hasPrefs = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'driver_ride_preferences'");
    if (hasPrefs.rowCount === 0) {
      console.log('⚡ Applying vehicle classification + ride preferences schema (031)...');
      const schemaPath = path.join(__dirname, '../migrations/031_vehicle_classification_and_preferences.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Vehicle classification + ride preferences schema (031) applied');
    }

    // Places search with PostGIS (033)
    const hasPlacesTable = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'places'");
    if (hasPlacesTable.rowCount === 0) {
      console.log('⚡ Applying places search schema with PostGIS (033)...');
      const schemaPath = path.join(__dirname, '../migrations/033_places_search.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Places search schema (033) applied successfully');
    }

    // Google Routes OD cache tables (032) — created once, then fed by
    // RouteStoreService. Wrapped in its own guard because the table was
    // defined before the bootstrap ever applied it.
    const hasRouteCache = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'route_cache'");
    if (hasRouteCache.rowCount === 0) {
      console.log('⚡ Applying Google Routes cache schema (032)...');
      const schemaPath = path.join(__dirname, '../migrations/032_google_routes_cache.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Google Routes cache schema (032) applied');
    }

    // Ride-scoped authoritative route store (034)
    const hasRideRoutes = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'ride_routes'");
    if (hasRideRoutes.rowCount === 0) {
      console.log('⚡ Applying ride route store schema (034)...');
      const schemaPath = path.join(__dirname, '../migrations/034_ride_routes.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Ride route store schema (034) applied');
    }

    // Partner + promo + referral + ride credits ecosystem (037)
    const hasPartners = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'partners'");
    if (hasPartners.rowCount === 0) {
      console.log('⚡ Applying partner/promo/referral/credits schema (037)...');
      const schemaPath = path.join(__dirname, '../migrations/037_partner_promo_referral_credits.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Partner/promo/referral/credits schema (037) applied');
    }

    // Referral onboarding + device fraud signals (038)
    const hasUserDevices = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'user_devices'");
    if (hasUserDevices.rowCount === 0) {
      console.log('⚡ Applying referral onboarding/device schema (038)...');
      const schemaPath = path.join(__dirname, '../migrations/038_referral_onboarding_device.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Referral onboarding/device schema (038) applied');
    }

    // Rider wallet — default fare payment method (039)
    const hasWallets = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'rider_wallets'");
    if (hasWallets.rowCount === 0) {
      console.log('⚡ Applying rider wallet schema (039)...');
      const schemaPath = path.join(__dirname, '../migrations/039_rider_wallet.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Rider wallet schema (039) applied');
    }

    // Real phone notifications + demand heatmap foundations (040)
    const hasDeviceTokens = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'device_tokens'");
    if (hasDeviceTokens.rowCount === 0) {
      console.log('⚡ Applying notifications + heatmap schema (040)...');
      const schemaPath = path.join(__dirname, '../migrations/040_notifications_heatmap.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Notifications + heatmap schema (040) applied');
    }

    // File-security classification + RLS hardening (057). Guarded on the
    // storage_files.visibility column this migration introduces.
    const hasFileVisibility = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'storage_files' AND column_name = 'visibility'"
    );
    if (hasFileVisibility.rowCount === 0) {
      console.log('⚡ Applying file-security + RLS hardening schema (057)...');
      const schemaPath = path.join(__dirname, '../migrations/057_file_security_and_rls_hardening.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ File-security + RLS hardening schema (057) applied');
    }

    // Purpose binding for one-time codes (060). Guarded on the
    // verification_codes.purpose column this migration introduces.
    const hasOtpPurpose = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'verification_codes' AND column_name = 'purpose'"
    );
    if (hasOtpPurpose.rowCount === 0) {
      console.log('🩹 Applying OTP purpose binding schema (060)...');
      const schemaPath = path.join(__dirname, '../migrations/060_otp_purpose.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ OTP purpose binding schema (060) applied');
    }

    // Hideable wallet history entries (061). Guarded on the
    // wallet_transactions.hidden_at column this migration introduces.
    const hasWalletTxHidden = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'wallet_transactions' AND column_name = 'hidden_at'"
    );
    if (hasWalletTxHidden.rowCount === 0) {
      console.log('🩹 Applying wallet transaction visibility schema (061)...');
      const schemaPath = path.join(__dirname, '../migrations/061_wallet_transactions_hidden.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Wallet transaction visibility schema (061) applied');
    }

    const hasAppReleaseConfigs = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'app_release_configs'"
    );
    if (hasAppReleaseConfigs.rowCount === 0) {
      console.log('Applying app release config schema (20261020)...');
      const schemaPath = path.join(__dirname, '../migrations/20261020_app_release_configs.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('App release config schema (20261020) applied');
    }

    const hasAppUpdateCampaigns = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'app_release_configs' AND column_name = 'draft_config'"
    );
    if (hasAppUpdateCampaigns.rowCount === 0) {
      console.log('Applying app update campaign schema (20261021)...');
      const schemaPath = path.join(__dirname, '../migrations/20261021_app_update_campaigns.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('App update campaign schema (20261021) applied');
    }

    const hasPayoutHidden = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'payouts' AND column_name = 'hidden_at'"
    );
    if (hasPayoutHidden.rowCount === 0) {
      console.log('Applying payout visibility schema (20261025)...');
      const schemaPath = path.join(__dirname, '../migrations/20261025_payouts_visibility.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('Payout visibility schema (20261025) applied');
    }

    console.log('🚀 All migrations completed');
  } catch (err: any) {
    console.error('❌ Migration/Seeding failed:', err.message);
  }
}

// Safety pipeline: every buffered trajectory point fans out to the
// SpeedingDetector. The detector itself is dormant under NODE_ENV=test
// so unit tests can drive the location stream without writing to PG.
trajectoryEvents.on('point', (payload) => {
  SpeedingDetector.onTrajectoryPoint(payload.driverId, payload.tripId, payload.point)
    .catch((err) => logger.error({ err: err.message, driverId: payload.driverId }, 'speeding_detector_threw'));
});
logger.info('[SAFETY] SpeedingDetector subscribed to trajectory events');

const PORT = process.env.PORT || 3000;

/**
 * Boot the HTTP/Socket.IO listener and all background jobs. Deliberately
 * NOT executed at module load: worker processes (matchWorker, cronWorker)
 * import this module via `io` and must never bind the port — an accidental
 * second `listen` is exactly what produced `EADDRINUSE` and crashed a
 * deployment when a job module pulled in ride.service → app.ts.
 *
 * The listener is also crash-proof: an `EADDRINUSE` (e.g. the previous
 * container instance still draining its port during a Render restart) is
 * retried with backoff instead of throwing an unhandled 'error' event that
 * would kill the whole container and start an endless restart loop.
 */
export function startServer(): void {
  let attempts = 0;
  const MAX_LISTEN_ATTEMPTS = 30; // 90s at the backoff schedule below
  const tryListen = (): void => {
    attempts++;
    httpServer.listen(Number(PORT), '0.0.0.0', onListen);
  };
  const onListen = (): void => {
    void bootJobs();
  };
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      if (attempts >= MAX_LISTEN_ATTEMPTS) {
        console.error(`[SERVER] 💥 Port ${PORT} stayed occupied for ${MAX_LISTEN_ATTEMPTS} attempts — giving up.`);
        process.exit(1);
      }
      const waitMs = Math.min(1000 * attempts, 15_000);
      console.warn(
        `[SERVER] ⚠️ Port ${PORT} busy (attempt ${attempts}/${MAX_LISTEN_ATTEMPTS}) — retrying in ${waitMs}ms (stale instance still draining).`,
      );
      setTimeout(tryListen, waitMs);
    } else {
      console.error(`[SERVER] 💥 HTTP server error: ${err.message}`);
      process.exit(1);
    }
  });
  tryListen();

  async function bootJobs(): Promise<void> {
  await runMigrations();
  logger.info({ port: Number(PORT), env: env.NODE_ENV }, 'server_listening');

  logger.info({ set: !!env.JWT_SECRET, length: env.JWT_SECRET?.length ?? 0 }, 'jwt_secret_status');

  logger.info({
    googleRoutes: 'SOLE',
    osrm: '(removed)',
    ors: '(removed)',
    astar: '(removed)',
  }, 'routing_engines');

  // -----------------------------------------------------------------
  // Self-keep-alive: ping our own /health/live every 60s so Render
  // free-tier doesn't spin the service down. Uses Node's http module
  // because curl isn't available in the Docker image.
  // -----------------------------------------------------------------
  const keepAliveUrl = `http://127.0.0.1:${PORT}/health/live`;
  setInterval(() => {
    const http = require('http');
    http.get(keepAliveUrl, (res: any) => {
      // consume data to free memory
      res.resume();
    }).on('error', () => {
      // silent — the endpoint may not be ready yet during cold start
    });
  }, 60_000);

  // Pre-cache routes for the launch market (Hollywood / UCLA / Beverly Hills
  // / Westwood). preCacheHotZones computes the full grid — the routing
  // service caches the results so future identical requests are instant.
  GeospatialService.preCacheHotZones([
    [34.0928, -118.3287], // Hollywood
    [34.0639, -118.4455], // Westwood / UCLA
    [34.0736, -118.4004], // Beverly Hills
    [34.1019, -118.3387], // Runyon Canyon
  ]);

  // Periodic Maintenance (Every 2 minutes)
  import('./services/cleanup.service').then(({ CleanupService }) => {
    setInterval(() => {
      CleanupService.performMaintenance();
    }, 2 * 60 * 1000);

    // Initial run
    CleanupService.performMaintenance();
  });

  // Boot-time stale-ride reconciliation: instantly resolve any rides left
  // stuck in a non-terminal state from before this deploy (apps killed
  // mid-trip, abandoned pickups, crashed workers). Without this, a driver
  // relaunching mid-stale-ride would re-attach to a ride that no longer
  // exists, and the admin dashboard would keep listing a ghost "active"
  // ride. Compliments the periodic watchdog in cleanupStaleRides.ts.
  import('./queue/jobs/cleanupStaleRides').then(({ sweepStaleActiveRides, sweepDriverConnectivity }) => {
    sweepStaleActiveRides(io)
      .then((n) => {
        if (n > 0) console.log(`[BOOT] 🧹 Reconciled ${n} stale rides left over from previous runtime`);
      })
      .catch((err: any) => console.error(`[BOOT] ⚠️ Stale ride reconciliation failed: ${err.message}`));

    // Driver-connectivity watchdog: detects an accepted/in-progress ride
    // whose driver's app stopped reporting and notifies the rider. Runs in
    // the API process too (not only the cron worker) so single-process
    // deployments keep the guarantee.
    setInterval(() => {
      sweepDriverConnectivity(io).catch((err: any) =>
        console.error(`[CRON] Driver connectivity sweep failed: ${err.message}`),
      );
    }, 2 * 60 * 1000);
  });

  // Special redemption hygiene (Every 5 minutes): expire stale validation
  // codes, release the reserved budget (spec §28/§69), collect the remaining
  // fare from riders whose special was never validated, and reconcile any
  // REWARD_COMPLETED redemption whose settlement components were not
  // recorded (crash between redemption tx and component write).
  setInterval(() => {
    SpecialRedemptionService.expireStaleRedemptions()
      .then((n) => { if (n > 0) logger.info({ expired: n }, 'cron_special_redemptions_expired'); })
      .catch((err: any) => logger.error({ err: err.message }, 'cron_special_redemptions_error'));
    RideSettlementService.sweepExpiredAdditionalCharges()
      .then((n) => { if (n > 0) logger.info({ retried: n }, 'cron_special_expiry_retry' ); })
      .catch((err: any) => logger.error({ err: err.message }, 'cron_special_expiry_retry_error'));
    SpecialRedemptionService.reconcileSettledRedemptions()
      .then((n) => { if (n > 0) logger.info({ reconciled: n }, 'cron_special_settlement_reconcile'); })
      .catch((err: any) => logger.error({ err: err.message }, 'cron_special_settlement_reconcile_error'));
  }, 5 * 60 * 1000);

  // Scheduled Rides Job (Every 1 minute)
  import('./services/scheduler.service').then(({ SchedulerService }) => {
    setInterval(() => {
      SchedulerService.checkScheduledRides();
    }, 60 * 1000);
  });

  // Refresh Platform Pricing Market Conditions (Every 5 minutes)
  import('./services/pricing.service').then(({ pricingService }) => {
    const refresh = () => {
      pricingService.refreshMarketConditions().catch((err: any) => {
        console.error(`[PRICING] ❌ Market refresh failed: ${err.message}`);
      });
    };
    setInterval(refresh, 5 * 60 * 1000);

    // Initial run on start
    refresh();
  });

  // Vehicle Data Background Sync (Once on start)
  import('./services/vehicleData.service').then(({ VehicleDataService }) => {
    VehicleDataService.syncCommonVehicles()
      .catch((err: any) => console.error(`[VEHICLE SYNC] ⚠️ Background sync failed (non-fatal): ${err.message}`));
  });

  // Weekly auto-payout sweep — RETIRED: withdrawals are manual only (driver
  // presses Withdraw in the app; created once per week, window opens Monday
  // 00:00 UTC). The tick is kept as a no-op guard, not a scheduler.
  import('./services/weeklyPayouts.service').then(({ WeeklyPayoutsService }) => {
    setInterval(() => {
      WeeklyPayoutsService.tick()
        .then((r) => {
          if (r.skipped.some((s) => s !== 'manual-withdrawals-only')) {
            logger.warn({ skipped: r.skipped }, 'cron_weekly_payouts_UNEXPECTED');
          }
        })
        .catch((err) => logger.error({ err: err.message }, 'cron_weekly_payouts_error'));
    }, 60 * 60 * 1000); // hourly no-op guard, never creates payouts
  });

  // Manual sponsor budget withdrawals: replay refunds for PENDING/FAILED
  // requests (idempotent via per-charge refund keys).
  import('./modules/payments/withdrawal.service').then(({ sweepSponsorWithdrawals, sweepDriverPayouts }) => {
    setInterval(() => {
      sweepSponsorWithdrawals()
        .then((n) => { if (n > 0) logger.info({ retried: n }, 'cron_sponsor_withdrawals_retry'); })
        .catch((err: any) => logger.error({ err: err.message }, 'cron_sponsor_withdrawals_error'));
      // AUTOMATIC driver payouts: requests are transferred immediately; this
      // sweep retries payouts whose transfer is still pending because the
      // connected account was not yet eligible or the Stripe API was
      // temporarily unavailable. No Admin approval is involved.
      sweepDriverPayouts()
        .then((n) => { if (n > 0) logger.info({ transferred: n }, 'cron_driver_payouts_auto'); })
        .catch((err: any) => logger.error({ err: err.message }, 'cron_driver_payouts_error'));
    }, 5 * 60 * 1000);
  });
  }
}


// Only the process that literally starts `node dist/app.js` binds the port.
// Every other consumer (workers importing `io`) stays listener-free.
if (require.main === module) {
  startServer();
}

export { io };