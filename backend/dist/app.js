"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.io = void 0;
// backend/src/app.ts
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const cors_1 = __importDefault(require("cors"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const env_1 = require("./config/env");
const database_1 = require("./config/database");
const auth_service_1 = require("./modules/auth/auth.service");
const socket_gateway_1 = require("./gateway/socket.gateway");
const rateLimit_middleware_1 = require("./middleware/rateLimit.middleware");
const sentry_1 = require("./observability/sentry");
const logger_1 = require("./observability/logger");
const pinoHttp_1 = require("./middleware/pinoHttp");
const health_controller_1 = __importDefault(require("./health/health.controller"));
const metrics_1 = require("./observability/metrics");
// Sentry must initialize before any other module that may throw at
// import time so it can capture those errors.
(0, sentry_1.initSentry)();
// Route Imports
const auth_routes_1 = __importDefault(require("./modules/auth/auth.routes"));
const user_routes_1 = __importDefault(require("./modules/user/user.routes"));
const driver_routes_1 = __importDefault(require("./modules/driver/driver.routes"));
const ride_routes_1 = __importDefault(require("./modules/ride/ride.routes"));
const geospatial_routes_1 = __importDefault(require("./modules/geospatial/geospatial.routes"));
const navigation_routes_1 = __importDefault(require("./modules/navigation/navigation.routes"));
const admin_routes_1 = __importDefault(require("./modules/admin/admin.routes"));
const face_routes_1 = __importDefault(require("./modules/face/face.routes"));
const geospatial_service_1 = require("./modules/geospatial/geospatial.service");
const upload_service_1 = require("./services/upload.service");
const speeding_detector_1 = require("./services/speeding_detector");
const locations_service_1 = require("./modules/location/locations.service");
const app = (0, express_1.default)();
const httpServer = (0, http_1.createServer)(app);
const io = new socket_io_1.Server(httpServer, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});
exports.io = io;
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ limit: '50mb', extended: true }));
// Request-id + child logger context. Mount BEFORE rate-limit so even
// 429s get a log line and a metric.
app.use(pinoHttp_1.requestContext);
app.use(pinoHttp_1.requestLogger);
app.use(rateLimit_middleware_1.rateLimitMiddleware);
// Serve static files from the uploads directory
app.use('/uploads', express_1.default.static(path_1.default.join(__dirname, '../uploads')));
// Backwards-compatible health endpoint (same shape as before).
// New load-balancer-friendly endpoints live at /health/live and
// /health/ready (see health.controller.ts).
app.get('/health', async (req, res) => {
    try {
        await database_1.pool.query('SELECT 1');
        res.json({ status: 'OK', database: 'connected' });
    }
    catch (err) {
        logger_1.logger.error({ err: err.message }, 'health_check_db_failed');
        res.status(500).json({
            status: 'ERROR',
            database: 'disconnected',
            message: err.message
        });
    }
});
app.use(health_controller_1.default);
// Prometheus scrape endpoint. Exposed unauthenticated on the assumption
// the network policy (or reverse proxy) restricts it to the metrics scraper.
app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', metrics_1.register.contentType);
    res.send(await metrics_1.register.metrics());
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
        const decoded = auth_service_1.AuthService.verifyToken(pureToken);
        socket.user = decoded;
        next();
    }
    catch (err) {
        console.error(`[AUTH] ❌ Socket JWT verification failed:`, err.message);
        return next(new Error('Authentication error: Invalid token'));
    }
});
// Initialize Gateway
(0, socket_gateway_1.setupSocketGateway)(io);
// Mount Routes
app.use('/api/auth', auth_routes_1.default);
app.use('/api/user', user_routes_1.default);
app.use('/api/driver', driver_routes_1.default);
app.use('/api/ride', ride_routes_1.default);
app.use('/api/geospatial', geospatial_routes_1.default);
app.use('/api/navigation', navigation_routes_1.default);
app.use('/api/admin', admin_routes_1.default);
app.use('/api/face', face_routes_1.default);
app.post('/api/upload', upload_service_1.UploadService.upload);
// Global Error Handler
app.use((err, req, res, next) => {
    console.error('[SERVER] 💥 Unhandled Error:', err);
    // Don't expose internal error details in production-like responses
    res.status(err.status || 500).json({
        error: 'An unexpected error occurred on our end. Our team has been notified.'
    });
});
async function runMigrations() {
    try {
        // Initial Schema
        const ridesTable = await database_1.pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'rides'");
        if (ridesTable.rowCount === 0) {
            console.log('⚡ Initializing database schema (001)...');
            const schemaPath = path_1.default.join(__dirname, '../migrations/001_initial_schema.sql');
            const schema = fs_1.default.readFileSync(schemaPath, 'utf8');
            await database_1.pool.query(schema);
            console.log('✅ Initial schema (001) initialized successfully');
        }
        // Verification Schema
        const otpTable = await database_1.pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'verification_codes'");
        if (otpTable.rowCount === 0) {
            console.log('⚡ Initializing verification schema (002)...');
            const schemaPath = path_1.default.join(__dirname, '../migrations/002_auth_verification.sql');
            const schema = fs_1.default.readFileSync(schemaPath, 'utf8');
            await database_1.pool.query(schema);
            console.log('✅ Verification schema (002) initialized successfully');
        }
        // Fix User Schema
        const hasPasswordHash = await database_1.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'password_hash'");
        if (hasPasswordHash.rowCount === 0) {
            console.log('⚡ Patching user schema (003)...');
            const schemaPath = path_1.default.join(__dirname, '../migrations/003_fix_user_schema.sql');
            const schema = fs_1.default.readFileSync(schemaPath, 'utf8');
            await database_1.pool.query(schema);
            console.log('✅ User schema patched successfully');
        }
        // Add License Back Photo
        const hasLicenseBack = await database_1.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'drivers' AND column_name = 'license_photo_back_url'");
        if (hasLicenseBack.rowCount === 0) {
            console.log('⚡ Patching driver schema (004)...');
            const schemaPath = path_1.default.join(__dirname, '../migrations/004_add_license_back_photo.sql');
            const schema = fs_1.default.readFileSync(schemaPath, 'utf8');
            await database_1.pool.query(schema);
            console.log('✅ Driver schema (004) patched successfully');
        }
        // Add Insurance/Registration
        const hasInsurance = await database_1.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'drivers' AND column_name = 'insurance_photo_url'");
        if (hasInsurance.rowCount === 0) {
            console.log('⚡ Patching driver schema (005)...');
            const schemaPath = path_1.default.join(__dirname, '../migrations/005_add_insurance_registration.sql');
            const schema = fs_1.default.readFileSync(schemaPath, 'utf8');
            await database_1.pool.query(schema);
            console.log('✅ Driver schema (005) patched successfully');
        }
        // Add Is Active to Users
        const hasIsActive = await database_1.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'is_active'");
        if (hasIsActive.rowCount === 0) {
            console.log('⚡ Patching user schema (006)...');
            const schemaPath = path_1.default.join(__dirname, '../migrations/006_add_is_active_to_users.sql');
            const schema = fs_1.default.readFileSync(schemaPath, 'utf8');
            await database_1.pool.query(schema);
            console.log('✅ User schema (006) patched successfully');
        }
        // Add Ratings and Moving Average
        const hasRating = await database_1.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'rating'");
        if (hasRating.rowCount === 0) {
            console.log('⚡ Patching ratings schema (007)...');
            const schemaPath = path_1.default.join(__dirname, '../migrations/007_add_ratings_and_moving_average.sql');
            const schema = fs_1.default.readFileSync(schemaPath, 'utf8');
            await database_1.pool.query(schema);
            console.log('✅ Ratings schema (007) patched successfully');
        }
        // Add Vehicle Models
        const hasVehicleModels = await database_1.pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'vehicle_models'");
        if (hasVehicleModels.rowCount === 0) {
            console.log('⚡ Patching vehicle models schema (008)...');
            const schemaPath = path_1.default.join(__dirname, '../migrations/008_add_vehicle_models.sql');
            const schema = fs_1.default.readFileSync(schemaPath, 'utf8');
            await database_1.pool.query(schema);
            console.log('✅ Vehicle models schema (008) patched successfully');
        }
        // Add Admin and Audit Logs
        const hasAuditLogs = await database_1.pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_logs'");
        if (hasAuditLogs.rowCount === 0) {
            console.log('⚡ Patching admin schema (009)...');
            const schemaPath = path_1.default.join(__dirname, '../migrations/009_admin_and_audit_logs.sql');
            const schema = fs_1.default.readFileSync(schemaPath, 'utf8');
            await database_1.pool.query(schema);
            console.log('✅ Admin schema (009) patched successfully');
        }
        // Add ID Photos to users (010)
        const hasUserIdPhotos = await database_1.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'id_photo_front_url'");
        if (hasUserIdPhotos.rowCount === 0) {
            console.log('⚡ Patching user schema (010)...');
            const schemaPath = path_1.default.join(__dirname, '../migrations/010_add_user_id_photos.sql');
            const schema = fs_1.default.readFileSync(schemaPath, 'utf8');
            await database_1.pool.query(schema);
            console.log('✅ User schema (010) patched successfully');
        }
        // Add Password Expiration (011)
        const hasPasswordChangedAt = await database_1.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'password_changed_at'");
        if (hasPasswordChangedAt.rowCount === 0) {
            console.log('⚡ Patching user schema (011)...');
            const schemaPath = path_1.default.join(__dirname, '../migrations/011_add_password_expiration.sql');
            const schema = fs_1.default.readFileSync(schemaPath, 'utf8');
            await database_1.pool.query(schema);
            console.log('✅ User schema (011) patched successfully');
        }
        // Upgrade Ride Schema (012)
        const hasTrajectory = await database_1.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'rides' AND column_name = 'trajectory'");
        if (hasTrajectory.rowCount === 0) {
            console.log('⚡ Patching ride schema (012)...');
            const schemaPath = path_1.default.join(__dirname, '../migrations/012_upgrade_ride_schema.sql');
            const schema = fs_1.default.readFileSync(schemaPath, 'utf8');
            await database_1.pool.query(schema);
            console.log('✅ Ride schema (012) patched successfully');
        }
        // Upgrade Vehicle Classes (013)
        const hasServiceClass = await database_1.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'vehicles' AND column_name = 'service_class'");
        if (hasServiceClass.rowCount === 0) {
            console.log('⚡ Patching vehicle classes schema (013)...');
            const schemaPath = path_1.default.join(__dirname, '../migrations/013_upgrade_vehicle_classes.sql');
            const schema = fs_1.default.readFileSync(schemaPath, 'utf8');
            await database_1.pool.query(schema);
            console.log('✅ Vehicle classes schema (013) patched successfully');
        }
        // Add Vehicle Inspection and Compliance Snapshot (014)
        const hasComplianceSnapshot = await database_1.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'rides' AND column_name = 'compliance_snapshot'");
        if (hasComplianceSnapshot.rowCount === 0) {
            console.log('⚡ Patching compliance schema (014)...');
            const schemaPath = path_1.default.join(__dirname, '../migrations/014_add_vehicle_inspection_and_compliance.sql');
            const schema = fs_1.default.readFileSync(schemaPath, 'utf8');
            await database_1.pool.query(schema);
            console.log('✅ Compliance schema (014) patched successfully');
        }
        // Add Favorites, Scheduling, and Tipping (015)
        const hasFavoriteDrivers = await database_1.pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'favorite_drivers'");
        if (hasFavoriteDrivers.rowCount === 0) {
            console.log('⚡ Patching features schema (015)...');
            const schemaPath = path_1.default.join(__dirname, '../migrations/015_add_favorites_scheduling_tipping.sql');
            const schema = fs_1.default.readFileSync(schemaPath, 'utf8');
            await database_1.pool.query(schema);
            console.log('✅ Features schema (015) patched successfully');
        }
        // Enable RLS and Policies (016)
        // Check if RLS is enabled on 'users' table as a proxy for this migration
        const isRlsEnabled = await database_1.pool.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'users'");
        if (isRlsEnabled.rows[0]?.relrowsecurity === false) {
            console.log('⚡ Securing database with RLS and Policies (016)...');
            const schemaPath = path_1.default.join(__dirname, '../migrations/016_enable_rls_and_policies.sql');
            const schema = fs_1.default.readFileSync(schemaPath, 'utf8');
            await database_1.pool.query(schema);
            console.log('✅ Database security (016) applied successfully');
        }
        // Face verification schema (018)
        const hasFaceEnrollment = await database_1.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'face_enrollment_url'");
        if (hasFaceEnrollment.rowCount === 0) {
            console.log('⚡ Patching face verification schema (018)...');
            const schemaPath = path_1.default.join(__dirname, '../migrations/018_add_face_verification.sql');
            const schema = fs_1.default.readFileSync(schemaPath, 'utf8');
            await database_1.pool.query(schema);
            console.log('✅ Face verification schema (018) applied successfully');
        }
        // Navigation + safety schema (019): route_metadata on rides and
        // the speeding_violations ledger for the dangerous-driver flag.
        const hasRouteMetadata = await database_1.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'rides' AND column_name = 'route_metadata'");
        if (hasRouteMetadata.rowCount === 0) {
            console.log('⚡ Patching navigation + safety schema (019)...');
            const schemaPath = path_1.default.join(__dirname, '../migrations/019_navigation_safety.sql');
            const schema = fs_1.default.readFileSync(schemaPath, 'utf8');
            await database_1.pool.query(schema);
            console.log('✅ Navigation + safety schema (019) applied successfully');
        }
        // Profile-change approval + wallet + payouts (020).
        const hasProfileChangeRequests = await database_1.pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'profile_change_requests'");
        if (hasProfileChangeRequests.rowCount === 0) {
            console.log('⚡ Patching profile-change + wallet + payouts schema (020)...');
            const schemaPath = path_1.default.join(__dirname, '../migrations/020_profile_changes_wallet_payouts.sql');
            const schema = fs_1.default.readFileSync(schemaPath, 'utf8');
            await database_1.pool.query(schema);
            console.log('✅ Profile-change + wallet + payouts schema (020) applied successfully');
        }
        console.log('🚀 All migrations completed');
    }
    catch (err) {
        console.error('❌ Migration/Seeding failed:', err.message);
    }
}
// Safety pipeline: every buffered trajectory point fans out to the
// SpeedingDetector. The detector itself is dormant under NODE_ENV=test
// so unit tests can drive the location stream without writing to PG.
locations_service_1.trajectoryEvents.on('point', (payload) => {
    speeding_detector_1.SpeedingDetector.onTrajectoryPoint(payload.driverId, payload.tripId, payload.point)
        .catch((err) => logger_1.logger.error({ err: err.message, driverId: payload.driverId }, 'speeding_detector_threw'));
});
logger_1.logger.info('[SAFETY] SpeedingDetector subscribed to trajectory events');
const PORT = process.env.PORT || 3000;
httpServer.listen(Number(PORT), '0.0.0.0', async () => {
    await runMigrations();
    logger_1.logger.info({ port: Number(PORT), env: env_1.env.NODE_ENV }, 'server_listening');
    logger_1.logger.info({ set: !!env_1.env.JWT_SECRET, length: env_1.env.JWT_SECRET?.length ?? 0 }, 'jwt_secret_status');
    // Pre-cache OSRM routes for the launch market (Hollywood / UCLA /
    // Beverly Hills / Westwood). The coords are landmarks, not
    // pre-cached OD pairs — preCacheHotZones computes the full grid.
    geospatial_service_1.GeospatialService.preCacheHotZones([
        [34.0928, -118.3287], // Hollywood
        [34.0639, -118.4455], // Westwood / UCLA
        [34.0736, -118.4004], // Beverly Hills
        [34.1019, -118.3387], // Runyon Canyon
    ]);
    // Periodic Maintenance (Every 2 minutes)
    Promise.resolve().then(() => __importStar(require('./services/cleanup.service'))).then(({ CleanupService }) => {
        setInterval(() => {
            CleanupService.performMaintenance();
        }, 2 * 60 * 1000);
        // Initial run
        CleanupService.performMaintenance();
    });
    // Scheduled Rides Job (Every 1 minute)
    Promise.resolve().then(() => __importStar(require('./services/scheduler.service'))).then(({ SchedulerService }) => {
        setInterval(() => {
            SchedulerService.checkScheduledRides();
        }, 60 * 1000);
    });
    // Recalculate Driver Pricing Ranges (Every 30 minutes)
    Promise.resolve().then(() => __importStar(require('./services/fare.service'))).then(({ fareService }) => {
        setInterval(() => {
            fareService.recalculateDriverRanges();
        }, 30 * 60 * 1000);
        // Initial run on start
        fareService.recalculateDriverRanges();
    });
    // Vehicle Data Background Sync (Once on start)
    Promise.resolve().then(() => __importStar(require('./services/vehicleData.service'))).then(({ VehicleDataService }) => {
        VehicleDataService.syncCommonVehicles();
    });
    // Weekly auto-payout sweep — checks once per minute, only fires on
    // Monday 09:00 UTC. Idempotent via Redis lock + partial UNIQUE INDEX.
    Promise.resolve().then(() => __importStar(require('./services/weeklyPayouts.service'))).then(({ WeeklyPayoutsService }) => {
        setInterval(() => {
            WeeklyPayoutsService.tick()
                .then((r) => {
                if (r.fired)
                    logger_1.logger.info({ processed: r.processed }, 'cron_weekly_payouts_fired');
                else if (r.skipped.length)
                    logger_1.logger.info({ skipped: r.skipped }, 'cron_weekly_payouts_skipped');
            })
                .catch((err) => logger_1.logger.error({ err: err.message }, 'cron_weekly_payouts_error'));
        }, 60 * 1000);
    });
});
//# sourceMappingURL=app.js.map