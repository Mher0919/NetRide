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

// Route Imports
import authRoutes from './modules/auth/auth.routes';
import userRoutes from './modules/user/user.routes';
import driverRoutes from './modules/driver/driver.routes';
import rideRoutes from './modules/ride/ride.routes';
import geospatialRoutes from './modules/geospatial/geospatial.routes';
import adminRoutes from './modules/admin/admin.routes';
import { GeospatialService } from './modules/geospatial/geospatial.service';
import { UploadService } from './services/upload.service';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(rateLimitMiddleware);

// Serve static files from the uploads directory
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Health Check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'OK', database: 'connected' });
  } catch (err: any) {
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
app.use('/api/admin', adminRoutes);
app.post('/api/upload', UploadService.upload);

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
  } catch (err: any) {
    console.error('❌ Migration/Seeding failed:', err.message);
  }
}

const PORT = process.env.PORT || 3000;
httpServer.listen(Number(PORT), '0.0.0.0', async () => {
  await runMigrations();
  console.log(`🚀 Server is listening on 0.0.0.0:${PORT} [MODE: ${env.NODE_ENV}]`);

  // Trigger Predictive Pre-caching for LA Hot Zones
  GeospatialService.preCacheHotZones([
    [33.9416, -118.4085], // LAX
    [34.0195, -118.4912], // Santa Monica
    [34.0928, -118.3287], // Hollywood
    [34.0407, -118.2468], // Downtown LA
  ]);
});

export { io };
