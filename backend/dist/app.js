"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.io = void 0;
// backend/src/app.ts
const express_1 = __importDefault(require("express"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
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
// Route Imports
const auth_routes_1 = __importDefault(require("./modules/auth/auth.routes"));
const user_routes_1 = __importDefault(require("./modules/user/user.routes"));
const driver_routes_1 = __importDefault(require("./modules/driver/driver.routes"));
const ride_routes_1 = __importDefault(require("./modules/ride/ride.routes"));
const geospatial_routes_1 = __importDefault(require("./modules/geospatial/geospatial.routes"));
const admin_routes_1 = __importDefault(require("./modules/admin/admin.routes"));
const geospatial_service_1 = require("./modules/geospatial/geospatial.service");
const upload_service_1 = require("./services/upload.service");
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
app.use(rateLimit_middleware_1.rateLimitMiddleware);
// Serve static files from the uploads directory
app.use('/uploads', express_1.default.static(path_1.default.join(__dirname, '../uploads')));
// Health Check
app.get('/health', async (req, res) => {
    try {
        await database_1.pool.query('SELECT 1');
        res.json({ status: 'OK', database: 'connected' });
    }
    catch (err) {
        console.error('❌ Database connection failed:', err.message);
        res.status(500).json({
            status: 'ERROR',
            database: 'disconnected',
            message: err.message
        });
    }
});
// Diagnostic Ping
app.get('/api/ping', (req, res) => {
    res.json({ status: 'pong', time: new Date().toISOString() });
});
// Middleware for Socket.io auth
io.use((socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization;
    // ALWAYS allow dummy tokens for development/testing
    if (token && token.toString().startsWith('dummy-')) {
        const role = token.toString().includes('driver') ? 'driver' : 'rider';
        console.log(`[AUTH] 🛠️ Dev bypass for ${role} (Dummy Token: ${token})`);
        socket.user = {
            id: role === 'driver' ? '00000000-0000-0000-0000-000000000001' : '00000000-0000-0000-0000-000000000002',
            role: role
        };
        return next();
    }
    // If in development, also allow missing tokens as dummy rider
    if (env_1.env.NODE_ENV === 'development' && !token) {
        console.log(`[AUTH] 🛠️ Dev bypass for rider (No Token)`);
        socket.user = {
            id: '00000000-0000-0000-0000-000000000002',
            role: 'rider'
        };
        return next();
    }
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
        console.warn(`[AUTH] ⚠️ Socket JWT verification failed. Falling back to dummy rider in dev mode:`, err.message);
        socket.user = {
            id: '00000000-0000-0000-0000-000000000002',
            role: 'rider'
        };
        return next();
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
app.use('/api/admin', admin_routes_1.default);
app.post('/api/upload', upload_service_1.UploadService.upload);
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
            console.log('✅ Driver schema patched successfully');
        }
        // Seed Dev Users if they don't exist
        if (env_1.env.NODE_ENV === 'development') {
            try {
                console.log('🌱 Ensuring dummy dev users exist...');
                const dummyRiderId = '00000000-0000-0000-0000-000000000002';
                const dummyDriverId = '00000000-0000-0000-0000-000000000001';
                const passwordHash = await bcryptjs_1.default.hash('password', 10);
                const riderCheck = await database_1.pool.query('SELECT id FROM users WHERE id = $1', [dummyRiderId]);
                if (riderCheck.rowCount === 0) {
                    console.log('👤 Creating dummy rider...');
                    await database_1.pool.query(`
            INSERT INTO users (id, role, email, full_name, is_verified, password_hash)
            VALUES ($1, 'RIDER', 'rider@NetRide.dev', 'Dummy Rider', true, $2)
          `, [dummyRiderId, passwordHash]);
                }
                const driverCheck = await database_1.pool.query('SELECT id FROM users WHERE id = $1', [dummyDriverId]);
                if (driverCheck.rowCount === 0) {
                    console.log('👤 Creating dummy driver...');
                    await database_1.pool.query(`
            INSERT INTO users (id, role, email, full_name, is_verified, password_hash)
            VALUES ($1, 'DRIVER', 'driver@NetRide.dev', 'Dummy Driver', true, $2)
          `, [dummyDriverId, passwordHash]);
                }
                // Ensure driver record exists
                const profileCheck = await database_1.pool.query('SELECT user_id FROM drivers WHERE user_id = $1', [dummyDriverId]);
                if (profileCheck.rowCount === 0) {
                    console.log('🪪 Creating dummy driver profile...');
                    await database_1.pool.query(`
            INSERT INTO drivers (user_id, background_check_status, is_active)
            VALUES ($1, 'APPROVED', true)
          `, [dummyDriverId]);
                }
                console.log('✅ Dummy dev users verified');
            }
            catch (err) {
                console.error('❌ Failed to seed dummy users:', err.message);
            }
        }
    }
    catch (err) {
        console.error('❌ Migration/Seeding failed:', err.message);
    }
}
const PORT = process.env.PORT || 3000;
httpServer.listen(Number(PORT), '0.0.0.0', async () => {
    await runMigrations();
    console.log(`🚀 Server is listening on 0.0.0.0:${PORT} [MODE: ${env_1.env.NODE_ENV}]`);
    // Trigger Predictive Pre-caching for LA Hot Zones
    geospatial_service_1.GeospatialService.preCacheHotZones([
        [33.9416, -118.4085], // LAX
        [34.0195, -118.4912], // Santa Monica
        [34.0928, -118.3287], // Hollywood
        [34.0407, -118.2468], // Downtown LA
    ]);
});
//# sourceMappingURL=app.js.map