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
import { AuthService } from './modules/auth/auth.service';
import { setupSocketGateway } from './gateway/socket.gateway';
import { rateLimitMiddleware } from './middleware/rateLimit.middleware';
import { identifyUser } from './middleware/identifyUser.middleware';
import { initSentry } from './observability/sentry';
import { logger } from './observability/logger';
import { requestContext, requestLogger } from './middleware/pinoHttp';
import healthRouter from './health/health.controller';
import fileRoutes from './routes/files.routes';
import { register } from './observability/metrics';

// Sentry must initialize before any other module that may throw at
// import time so it can capture those errors.
initSentry();

// Route Imports
import authRoutes from './modules/auth/auth.routes';
import userRoutes from './modules/user/user.routes';
import driverRoutes from './modules/driver/driver.routes';
import rideRoutes from './modules/ride/ride.routes';
import geospatialRoutes from './modules/geospatial/geospatial.routes';
import navigationRoutes from './modules/navigation/navigation.routes';
import adminRoutes from './modules/admin/admin.routes';
import faceRoutes from './modules/face/face.routes';
import { GeospatialService } from './modules/geospatial/geospatial.service';
import { UploadService } from './services/upload.service';
import { SpeedingDetector } from './services/speeding_detector';
import { trajectoryEvents } from './modules/location/locations.service';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Step 10: Socket.IO redis adapter for multi-instance support.
// Uses separate pub/sub clients so regular Redis commands don't
// conflict with socket message broadcasting.
import { createAdapter } from '@socket.io/redis-adapter';
import { pubClient, subClient } from './config/redisPubSub';
try {
  io.adapter(createAdapter(pubClient, subClient));
} catch (adapterErr: any) {
  console.warn(`[SERVER] ⚠️ Socket.IO Redis adapter failed (non-fatal): ${adapterErr.message}`);
  console.warn('[SERVER] ⚠️ Multi-instance Socket.IO scaling disabled. Running in single-instance mode.');
}

app.use(cors());
// Trust Render proxy so req.ip resolves individual client IPs
// instead of the proxy IP. This fixes rate-limit key collisions
// where all users share one rate-limit bucket behind Render.
app.set('trust proxy', 1);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Request-id + child logger context. Mount BEFORE rate-limit so even
// 429s get a log line and a metric.
app.use(requestContext);
app.use(requestLogger);
// Optional auth — extracts user from JWT if present (no rejection).
// Must run BEFORE rate-limit so authenticated requests use user-based keys.
app.use(identifyUser);
app.use(rateLimitMiddleware);

// Serve static files from the uploads directory
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

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

// Middleware for Socket.io auth
io.use((socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.headers.authorization;

  if (!token) {
    return next(new Error('Authentication error: No token provided'));
  }
  
  try {
    const pureToken = token.toString().replace('Bearer ', '');
    const decoded = AuthService.verifyToken(pureToken);
    (socket as any).user = decoded;
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
app.use('/api/admin', adminRoutes);
app.use('/api/face', faceRoutes);
app.use('/api/files', fileRoutes);
app.post('/api/upload', UploadService.upload);

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

    // Face verification schema (018)
    const hasFaceEnrollment = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'face_enrollment_url'");
    if (hasFaceEnrollment.rowCount === 0) {
      console.log('⚡ Patching face verification schema (018)...');
      const schemaPath = path.join(__dirname, '../migrations/018_add_face_verification.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ Face verification schema (018) applied successfully');
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

    // Make audit_logs.admin_id nullable (029). System-generated events such
    // as automated face checks have no acting admin, so the column must
    // allow NULL. Guards on the column's nullability.
    const adminIdNullable = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_logs' AND column_name = 'admin_id' AND is_nullable = 'YES'"
    );
    if (adminIdNullable.rowCount === 0) {
      console.log('⚡ Relaxing audit_logs.admin_id nullability (029)...');
      const schemaPath = path.join(__dirname, '../migrations/20260718_face_audit_admin_nullable.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ audit_logs.admin_id made nullable');
    }

    // Face enrollment descriptor column (face-api.js 128-d vector).
    const hasDescriptor = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'face_enrollment_descriptor'"
    );
    if (hasDescriptor.rowCount === 0) {
      console.log('⚡ Adding face_enrollment_descriptor column...');
      const schemaPath = path.join(__dirname, '../migrations/20260718_face_descriptor.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('✅ face_enrollment_descriptor column added');
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
httpServer.listen(Number(PORT), '0.0.0.0', async () => {
  await runMigrations();
  logger.info({ port: Number(PORT), env: env.NODE_ENV }, 'server_listening');

  // Warm up the in-process face models in the background so the first face
  // check doesn't pay the (slow) model-load / GitHub-fetch cost on the request
  // path. Failures are logged but non-fatal.
  import('./services/faceMatcher')
    .then(({ loadFaceModels }) => loadFaceModels())
    .then(() => logger.info('face_models_loaded'))
    .catch((e) => logger.warn({ err: e.message }, 'face_models_warmup_failed'));
  logger.info({ set: !!env.JWT_SECRET, length: env.JWT_SECRET?.length ?? 0 }, 'jwt_secret_status');

  // Pre-cache OSRM routes for the launch market (Hollywood / UCLA /
  // Beverly Hills / Westwood). The coords are landmarks, not
  // pre-cached OD pairs — preCacheHotZones computes the full grid.
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

  // Scheduled Rides Job (Every 1 minute)
  import('./services/scheduler.service').then(({ SchedulerService }) => {
    setInterval(() => {
      SchedulerService.checkScheduledRides();
    }, 60 * 1000);
  });

  // Recalculate Driver Pricing Ranges (Every 30 minutes)
  import('./services/fare.service').then(({ fareService }) => {
    setInterval(() => {
      fareService.recalculateDriverRanges();
    }, 30 * 60 * 1000);

    // Initial run on start
    fareService.recalculateDriverRanges();
  });

  // Vehicle Data Background Sync (Once on start)
  import('./services/vehicleData.service').then(({ VehicleDataService }) => {
    VehicleDataService.syncCommonVehicles();
  });

  // Weekly auto-payout sweep — checks once per minute, only fires on
  // Monday 09:00 UTC. Idempotent via Redis lock + partial UNIQUE INDEX.
  import('./services/weeklyPayouts.service').then(({ WeeklyPayoutsService }) => {
    setInterval(() => {
      WeeklyPayoutsService.tick()
        .then((r) => {
          if (r.fired) logger.info({ processed: r.processed }, 'cron_weekly_payouts_fired');
          else if (r.skipped.length) logger.info({ skipped: r.skipped }, 'cron_weekly_payouts_skipped');
        })
        .catch((err) => logger.error({ err: err.message }, 'cron_weekly_payouts_error'));
    }, 60 * 1000);
  });
});

export { io };