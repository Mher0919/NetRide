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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminController = void 0;
const prisma_service_1 = require("../../services/prisma.service");
const client_1 = require("@prisma/client");
const database_1 = require("../../config/database");
const speeding_detector_1 = require("../../services/speeding_detector");
const email_service_1 = require("../../services/email.service");
class AdminController {
    static async getStats(req, res) {
        try {
            const [totalRiders, totalDrivers, pendingVerifications, verifiedUsers, rejectedUsers] = await Promise.all([
                prisma_service_1.prisma.user.count({ where: { role: client_1.UserRole.RIDER } }),
                prisma_service_1.prisma.user.count({ where: { role: client_1.UserRole.DRIVER } }),
                prisma_service_1.prisma.user.count({ where: { verification_status: client_1.VerificationStatus.PENDING } }),
                prisma_service_1.prisma.user.count({ where: { verification_status: client_1.VerificationStatus.VERIFIED } }),
                prisma_service_1.prisma.user.count({ where: { verification_status: client_1.VerificationStatus.REJECTED } }),
            ]);
            res.json({
                totalRiders,
                totalDrivers,
                pendingVerifications,
                verifiedUsers,
                rejectedUsers,
            });
        }
        catch (error) {
            console.error(`[ADMIN] ❌ Stats error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve administrative statistics.' });
        }
    }
    static async getUsers(req, res) {
        const { role, status, search, page = 1, limit = 10, dangerousOnly } = req.query;
        const skip = (Number(page) - 1) * Number(limit);
        const where = {};
        if (role)
            where.role = role;
        if (status)
            where.verification_status = status;
        if (search) {
            where.OR = [
                { full_name: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
                { phone_number: { contains: search, mode: 'insensitive' } },
            ];
        }
        if (dangerousOnly === 'true') {
            where.driver_profile = { is: { is_dangerous: true } };
        }
        try {
            const [users, total] = await Promise.all([
                prisma_service_1.prisma.user.findMany({
                    where,
                    skip,
                    take: Number(limit),
                    orderBy: { created_at: 'desc' },
                    include: {
                        driver_profile: true,
                    },
                }),
                prisma_service_1.prisma.user.count({ where }),
            ]);
            res.json({
                users,
                total,
                page: Number(page),
                totalPages: Math.ceil(total / Number(limit)),
            });
        }
        catch (error) {
            console.error(`[ADMIN] ❌ Get users error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve user list.' });
        }
    }
    static async getUserById(req, res) {
        const { id } = req.params;
        try {
            const user = await prisma_service_1.prisma.user.findUnique({
                where: { id },
                include: {
                    driver_profile: {
                        include: {
                            vehicles: true,
                        },
                    },
                },
            });
            if (!user) {
                return res.status(404).json({ error: 'User record not found.' });
            }
            res.json(user);
        }
        catch (error) {
            console.error(`[ADMIN] ❌ Get user detail error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve user details.' });
        }
    }
    static async verifyUser(req, res) {
        const { id } = req.params;
        const adminId = req.user.id;
        try {
            const user = await prisma_service_1.prisma.user.update({
                where: { id },
                data: {
                    verification_status: client_1.VerificationStatus.VERIFIED,
                    is_verified: true,
                    verification_feedback_seen: false
                },
            });
            if (user.role === client_1.UserRole.DRIVER) {
                await prisma_service_1.prisma.driver.update({
                    where: { user_id: id },
                    data: {
                        background_check_status: 'APPROVED',
                        is_active: true,
                        verification_feedback_seen: false
                    },
                });
            }
            await prisma_service_1.prisma.auditLog.create({
                data: {
                    admin_id: adminId,
                    target_id: id,
                    action: 'VERIFY',
                    details: `User ${user.email} verified by admin.`,
                },
            });
            res.json({ message: 'User verified successfully', user });
        }
        catch (error) {
            console.error(`[ADMIN] ❌ Verify user error: ${error.message}`);
            res.status(500).json({ error: 'Failed to verify user.' });
        }
    }
    static async rejectUser(req, res) {
        const { id } = req.params;
        const { reason } = req.body;
        const adminId = req.user.id;
        if (!reason)
            return res.status(400).json({ error: 'A rejection reason is required.' });
        try {
            const user = await prisma_service_1.prisma.user.update({
                where: { id },
                data: {
                    verification_status: client_1.VerificationStatus.REJECTED,
                    is_verified: false,
                    rejection_reason: reason,
                    verification_feedback_seen: false
                },
            });
            if (user.role === client_1.UserRole.DRIVER) {
                await prisma_service_1.prisma.driver.update({
                    where: { user_id: id },
                    data: {
                        background_check_status: 'REJECTED',
                        is_active: false,
                        rejection_reason: reason,
                        verification_feedback_seen: false
                    },
                });
            }
            await prisma_service_1.prisma.auditLog.create({
                data: {
                    admin_id: adminId,
                    target_id: id,
                    action: 'REJECT',
                    details: `User ${user.email} rejected. Reason: ${reason}`,
                },
            });
            res.json({ message: 'User rejected', user });
        }
        catch (error) {
            console.error(`[ADMIN] ❌ Reject user error: ${error.message}`);
            res.status(500).json({ error: 'Failed to reject user.' });
        }
    }
    static async setPending(req, res) {
        const { id } = req.params;
        const adminId = req.user.id;
        try {
            const user = await prisma_service_1.prisma.user.update({
                where: { id },
                data: {
                    verification_status: client_1.VerificationStatus.PENDING,
                    is_verified: false,
                },
            });
            if (user.role === client_1.UserRole.DRIVER) {
                await prisma_service_1.prisma.driver.update({
                    where: { user_id: id },
                    data: {
                        background_check_status: 'PENDING',
                        is_active: false,
                    },
                });
            }
            await prisma_service_1.prisma.auditLog.create({
                data: {
                    admin_id: adminId,
                    target_id: id,
                    action: 'SET_PENDING',
                    details: `User ${user.email} set back to pending.`,
                },
            });
            res.json({ message: 'User status set to pending', user });
        }
        catch (error) {
            console.error(`[ADMIN] ❌ Set pending error: ${error.message}`);
            res.status(500).json({ error: 'Failed to update user status.' });
        }
    }
    static async getLogs(req, res) {
        const { page = 1, limit = 20 } = req.query;
        const skip = (Number(page) - 1) * Number(limit);
        try {
            const [logs, total] = await Promise.all([
                prisma_service_1.prisma.auditLog.findMany({
                    skip,
                    take: Number(limit),
                    orderBy: { created_at: 'desc' },
                    include: {
                        admin: { select: { full_name: true, email: true } },
                        target: { select: { full_name: true, email: true } },
                    },
                }),
                prisma_service_1.prisma.auditLog.count(),
            ]);
            res.json({
                logs,
                total,
                page: Number(page),
                totalPages: Math.ceil(total / Number(limit)),
            });
        }
        catch (error) {
            console.error(`[ADMIN] ❌ Get logs error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve audit logs.' });
        }
    }
    static async getRides(req, res) {
        const { status, page = 1, limit = 10 } = req.query;
        const skip = (Number(page) - 1) * Number(limit);
        const where = {};
        if (status) {
            if (status === 'ACTIVE') {
                where.status = { notIn: ['COMPLETED', 'CANCELLED'] };
            }
            else if (status === 'COMPLETED') {
                where.status = 'COMPLETED';
            }
            else {
                where.status = status;
            }
        }
        try {
            const [rides, total] = await Promise.all([
                prisma_service_1.prisma.ride.findMany({
                    where,
                    skip,
                    take: Number(limit),
                    orderBy: { created_at: 'desc' },
                    include: {
                        rider: { select: { full_name: true, email: true, phone_number: true } },
                        driver: { select: { full_name: true, email: true, phone_number: true } },
                    },
                }),
                prisma_service_1.prisma.ride.count({ where }),
            ]);
            res.json({
                rides,
                total,
                page: Number(page),
                totalPages: Math.ceil(total / Number(limit)),
            });
        }
        catch (error) {
            console.error(`[ADMIN] ❌ Get rides error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve ride list.' });
        }
    }
    static async getRideById(req, res) {
        const { id } = req.params;
        try {
            const ride = await prisma_service_1.prisma.ride.findUnique({
                where: { id },
                include: {
                    rider: { select: { full_name: true, email: true, phone_number: true, profile_image_url: true } },
                    driver: {
                        select: {
                            id: true,
                            full_name: true,
                            email: true,
                            phone_number: true,
                            profile_image_url: true,
                            driver_profile: {
                                include: { vehicles: true }
                            }
                        }
                    },
                    rating: true
                },
            });
            if (!ride)
                return res.status(404).json({ error: 'Ride not found.' });
            res.json(ride);
        }
        catch (error) {
            console.error(`[ADMIN] ❌ Get ride detail error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve ride details.' });
        }
    }
    static async verifyInspection(req, res) {
        const { vehicleId } = req.params;
        const { status, notes, expiryDate } = req.body;
        const adminId = req.user.id;
        try {
            const vehicle = await prisma_service_1.prisma.driverVehicle.update({
                where: { id: vehicleId },
                data: {
                    inspection_status: status,
                    inspection_notes: notes,
                    inspection_expiry_date: expiryDate ? new Date(expiryDate) : undefined
                }
            });
            if (status === 'REJECTED') {
                await prisma_service_1.prisma.driver.update({
                    where: { user_id: vehicle.driver_id },
                    data: {
                        rejection_reason: notes || 'Vehicle inspection failed.',
                        verification_feedback_seen: false
                    }
                });
            }
            else if (status === 'APPROVED') {
                await prisma_service_1.prisma.driver.update({
                    where: { user_id: vehicle.driver_id },
                    data: {
                        verification_feedback_seen: false
                    }
                });
            }
            await prisma_service_1.prisma.auditLog.create({
                data: {
                    admin_id: adminId,
                    target_id: vehicle.driver_id,
                    action: `INSPECTION_${status}`,
                    details: `Vehicle ${vehicle.license_plate_number} inspection status updated to ${status}. Notes: ${notes || 'None'}`,
                },
            });
            res.json({ message: 'Inspection status updated successfully', vehicle });
        }
        catch (error) {
            console.error(`[ADMIN] ❌ Verify inspection error: ${error.message}`);
            res.status(500).json({ error: 'Failed to update inspection status.' });
        }
    }
    static async getRideAudit(req, res) {
        const { id } = req.params;
        try {
            const ride = await prisma_service_1.prisma.ride.findUnique({
                where: { id },
                include: {
                    rider: { select: { id: true, full_name: true, email: true, rating: true } },
                    driver: {
                        select: {
                            id: true,
                            full_name: true,
                            email: true,
                            rating: true,
                            driver_profile: true
                        }
                    },
                    rating: true
                }
            });
            if (!ride)
                return res.status(404).json({ error: 'Ride not found.' });
            const timeline = [
                { event: 'REQUESTED', time: ride.created_at },
                { event: 'ACCEPTED', time: ride.accepted_at },
                { event: 'STARTED', time: ride.started_at },
                { event: 'COMPLETED', time: ride.completed_at },
                { event: 'CANCELLED', time: ride.cancelled_at }
            ].filter(e => e.time !== null).sort((a, b) => a.time.getTime() - b.time.getTime());
            res.json({
                ride_id: ride.id,
                status: ride.status,
                timeline,
                compliance_snapshot: ride.compliance_snapshot,
                ratings: {
                    rider_to_driver: ride.rating?.target_role === 'DRIVER' ? ride.rating : null,
                    all_ratings: await prisma_service_1.prisma.rating.findMany({ where: { ride_id: id } })
                }
            });
        }
        catch (error) {
            console.error(`[ADMIN] ❌ Get ride audit error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve ride audit.' });
        }
    }
    static async getLiveDrivers(req, res) {
        try {
            const { redis, DRIVER_LOCATIONS_KEY, DRIVER_HEARTBEAT_PREFIX } = await Promise.resolve().then(() => __importStar(require('../../config/redis')));
            const driverIds = await redis.zrange(DRIVER_LOCATIONS_KEY, 0, -1);
            const liveDrivers = [];
            for (const id of driverIds) {
                const [heartbeat, pos, activeTripId] = await Promise.all([
                    redis.get(`${DRIVER_HEARTBEAT_PREFIX}${id}`),
                    redis.geopos(DRIVER_LOCATIONS_KEY, id),
                    redis.get(`driver:${id}:active_trip`)
                ]);
                if (heartbeat && pos && pos[0]) {
                    const driver = await prisma_service_1.prisma.user.findUnique({
                        where: { id },
                        select: { full_name: true, email: true, phone_number: true }
                    });
                    liveDrivers.push({
                        id,
                        lat: parseFloat(pos[0][1]),
                        lng: parseFloat(pos[0][0]),
                        status: activeTripId ? 'BUSY' : 'AVAILABLE',
                        activeTripId,
                        info: driver
                    });
                }
            }
            res.json(liveDrivers);
        }
        catch (error) {
            console.error(`[ADMIN] ❌ Get live drivers error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve live driver status.' });
        }
    }
    /**
     * Fleet-wide view of recent speeding violations, newest first.
     * Used by the /speeding admin dashboard.
     */
    static async getSpeedingViolations(req, res) {
        try {
            const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);
            const dangerousOnly = req.query.dangerousOnly === 'true';
            const violations = await speeding_detector_1.SpeedingDetector.listRecent(limit);
            // Optional filter: only violations by drivers currently flagged.
            let filtered = violations;
            if (dangerousOnly) {
                const dangerousRes = await database_1.pool.query(`SELECT user_id FROM drivers WHERE is_dangerous = TRUE`);
                const dangerousSet = new Set(dangerousRes.rows.map(r => r.user_id));
                filtered = violations.filter((v) => dangerousSet.has(v.driver_id));
            }
            res.json({ violations: filtered, count: filtered.length });
        }
        catch (error) {
            console.error(`[ADMIN] ❌ Get speeding violations error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve speeding violations.' });
        }
    }
    /**
     * Per-driver speeding history. Used in UserDetail's Safety section.
     */
    static async getDriverSpeeding(req, res) {
        try {
            const { id } = req.params;
            const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
            const violations = await speeding_detector_1.SpeedingDetector.listForDriver(id, limit);
            res.json({ violations, count: violations.length });
        }
        catch (error) {
            console.error(`[ADMIN] ❌ Get driver speeding error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve driver speeding history.' });
        }
    }
    /**
     * List drivers flagged as dangerous. Includes violation counts so
     * the admin list view can sort by severity.
     */
    static async getDangerousDrivers(req, res) {
        try {
            const driversRes = await database_1.pool.query(`SELECT d.user_id, u.full_name, u.email, u.rating,
                d.is_dangerous, d.is_flagged,
                COUNT(DISTINCT sv.trip_id) AS recent_violation_trips
           FROM drivers d
           JOIN users u ON u.id = d.user_id
           LEFT JOIN speeding_violations sv
             ON sv.driver_id = d.user_id
            AND sv.created_at >= NOW() - INTERVAL '90 days'
          WHERE d.is_dangerous = TRUE OR d.is_flagged = TRUE
          GROUP BY d.user_id, u.full_name, u.email, u.rating,
                   d.is_dangerous, d.is_flagged
          ORDER BY recent_violation_trips DESC, u.full_name ASC`);
            res.json({ drivers: driversRes.rows, count: driversRes.rowCount });
        }
        catch (error) {
            console.error(`[ADMIN] ❌ Get dangerous drivers error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve dangerous drivers.' });
        }
    }
    /**
     * Manually clear the dangerous flag after admin review (warning
     * issued, retraining completed, etc). Writes an audit_log row.
     */
    static async clearDangerousFlag(req, res) {
        try {
            const { id } = req.params;
            const notes = req.body?.notes ?? null;
            const adminId = req.user.id;
            await speeding_detector_1.SpeedingDetector.clearDangerousFlag(id, adminId, notes ?? undefined);
            res.json({ success: true, driverId: id });
        }
        catch (error) {
            console.error(`[ADMIN] ❌ Clear dangerous flag error: ${error.message}`);
            res.status(500).json({ error: 'Failed to clear dangerous flag.' });
        }
    }
    // ============================================================
    // Profile-change approval queue (020)
    // ============================================================
    static async listProfileChanges(req, res) {
        try {
            const { status = 'PENDING', limit = '50', offset = '0' } = req.query;
            const lim = Math.min(parseInt(String(limit), 10) || 50, 200);
            const off = Math.max(parseInt(String(offset), 10) || 0, 0);
            const res0 = await database_1.pool.query(`SELECT pcr.id, pcr.driver_id, pcr.status, pcr.created_at, pcr.reviewed_at, pcr.card_last4, pcr.card_brand,
                pcr.requested_changes,
                u.full_name AS driver_name, u.email AS driver_email
         FROM profile_change_requests pcr
         JOIN users u ON u.id = pcr.driver_id
         WHERE pcr.status = $1
         ORDER BY pcr.created_at DESC
         LIMIT $2 OFFSET $3`, [status, lim, off]);
            const total = await database_1.pool.query(`SELECT COUNT(*)::int AS c FROM profile_change_requests WHERE status = $1`, [status]);
            res.json({ requests: res0.rows, count: total.rows[0]?.c ?? 0 });
        }
        catch (error) {
            console.error(`[ADMIN] ❌ List profile changes error: ${error.message}`);
            res.status(500).json({ error: 'Failed to list profile changes.' });
        }
    }
    static async getProfileChange(req, res) {
        try {
            const { id } = req.params;
            const res0 = await database_1.pool.query(`SELECT pcr.*, u.full_name, u.email, u.phone_number, u.profile_image_url, u.date_of_birth
         FROM profile_change_requests pcr
         JOIN users u ON u.id = pcr.driver_id
         WHERE pcr.id = $1`, [id]);
            if (!res0.rowCount)
                return res.status(404).json({ error: 'Profile change not found.' });
            // Fetch current values for comparison
            const driverId = res0.rows[0].driver_id;
            const driverRes = await database_1.pool.query(`SELECT user_id, license_number FROM drivers WHERE user_id = $1`, [driverId]);
            const vehRes = await database_1.pool.query(`SELECT make, model, year, color, license_plate_number, license_plate_photo_url, inspection_photo_url, car_photo_urls
         FROM driver_vehicles WHERE driver_id = $1 ORDER BY id DESC LIMIT 1`, [driverId]);
            res.json({
                change: res0.rows[0],
                driver: driverRes.rows[0] ?? null,
                vehicle: vehRes.rows[0] ?? null,
            });
        }
        catch (error) {
            console.error(`[ADMIN] ❌ Get profile change error: ${error.message}`);
            res.status(500).json({ error: 'Failed to fetch profile change.' });
        }
    }
    static async approveProfileChange(req, res) {
        const { id } = req.params;
        const adminId = req.user.id;
        const client = await database_1.pool.connect();
        try {
            await client.query('BEGIN');
            const lock = await client.query(`SELECT pcr.*, u.email, u.full_name FROM profile_change_requests pcr
         JOIN users u ON u.id = pcr.driver_id
         WHERE pcr.id = $1 FOR UPDATE`, [id]);
            if (!lock.rowCount)
                throw new Error('NOT_FOUND');
            const row = lock.rows[0];
            if (row.status !== 'PENDING')
                throw new Error('ALREADY_REVIEWED');
            const driverId = row.driver_id;
            const changes = row.requested_changes ?? {};
            const updatedFields = [];
            // Apply field diffs
            if (changes.full_name) {
                await client.query(`UPDATE users SET full_name = $1 WHERE id = $2`, [changes.full_name, driverId]);
                updatedFields.push('full_name');
            }
            if (changes.phone_number) {
                await client.query(`UPDATE users SET phone_number = $1 WHERE id = $2`, [changes.phone_number, driverId]);
                updatedFields.push('phone_number');
            }
            if (changes.date_of_birth) {
                await client.query(`UPDATE users SET date_of_birth = $1 WHERE id = $2`, [changes.date_of_birth, driverId]);
                updatedFields.push('date_of_birth');
            }
            if (changes.profile_image_url) {
                await client.query(`UPDATE users SET profile_image_url = $1 WHERE id = $2`, [changes.profile_image_url, driverId]);
                updatedFields.push('profile_image_url');
            }
            if (changes.license_number) {
                await client.query(`UPDATE drivers SET license_number = $1 WHERE user_id = $2`, [changes.license_number, driverId]);
                updatedFields.push('license_number');
            }
            // Vehicle fields — single vehicle per driver in current schema
            const vehicleFields = ['make', 'model', 'year', 'color', 'interior_color',
                'license_plate_number', 'license_plate_photo_url', 'inspection_photo_url', 'car_photo_urls'];
            const vehicleSets = [];
            const vehicleVals = [];
            let i = 1;
            for (const f of vehicleFields) {
                if (changes[f] !== undefined) {
                    vehicleSets.push(`${f} = $${i++}`);
                    vehicleVals.push(changes[f]);
                    updatedFields.push(f);
                }
            }
            if (vehicleSets.length > 0) {
                vehicleVals.push(driverId);
                await client.query(`UPDATE driver_vehicles SET ${vehicleSets.join(', ')} WHERE driver_id = $${i}`, vehicleVals);
            }
            // Payout card: if queued, flip to APPROVED and attach to wallet.
            if (changes.payout_card_id) {
                await client.query(`UPDATE payout_cards SET status = 'APPROVED', approved_at = NOW() WHERE id = $1 AND driver_id = $2`, [changes.payout_card_id, driverId]);
                await client.query(`INSERT INTO driver_wallets (driver_id, payout_card_id) VALUES ($1, $2)
           ON CONFLICT (driver_id) DO UPDATE SET payout_card_id = EXCLUDED.payout_card_id, updated_at = NOW()`, [driverId, changes.payout_card_id]);
                updatedFields.push('payout_card');
            }
            // Mark the request APPROVED + unblock the driver.
            await client.query(`UPDATE profile_change_requests SET status = 'APPROVED', reviewed_at = NOW(), reviewed_by_admin_id = $1 WHERE id = $2`, [adminId, id]);
            await client.query(`UPDATE drivers SET is_active = true, background_check_status = 'APPROVED', verification_feedback_seen = false WHERE user_id = $1`, [driverId]);
            await client.query(`INSERT INTO audit_logs (admin_id, target_id, action, details) VALUES ($1, $2, 'PROFILE_CHANGE_APPROVED', $3)`, [adminId, driverId, JSON.stringify({ request_id: id, updated_fields: updatedFields })]);
            await client.query('COMMIT');
            // Fire-and-forget side effects
            try {
                await email_service_1.EmailService.sendProfileChangeApprovedEmail({ email: row.email, full_name: row.full_name });
            }
            catch (e) {
                console.warn('[ADMIN] ⚠️ Approved email failed:', e.message);
            }
            res.json({ status: 'APPROVED', updated_fields: updatedFields });
        }
        catch (error) {
            await client.query('ROLLBACK');
            const code = error.message === 'NOT_FOUND' ? 404
                : error.message === 'ALREADY_REVIEWED' ? 409
                    : 400;
            console.error(`[ADMIN] ❌ Approve profile change error: ${error.message}`);
            res.status(code).json({ error: error.message || 'Failed to approve profile change.' });
        }
        finally {
            client.release();
        }
    }
    static async rejectProfileChange(req, res) {
        const { id } = req.params;
        const { reason } = req.body;
        const adminId = req.user.id;
        if (!reason || !String(reason).trim())
            return res.status(400).json({ error: 'A rejection reason is required.' });
        const client = await database_1.pool.connect();
        try {
            await client.query('BEGIN');
            const lock = await client.query(`SELECT pcr.*, u.email, u.full_name FROM profile_change_requests pcr
         JOIN users u ON u.id = pcr.driver_id
         WHERE pcr.id = $1 FOR UPDATE`, [id]);
            if (!lock.rowCount)
                throw new Error('NOT_FOUND');
            const row = lock.rows[0];
            if (row.status !== 'PENDING')
                throw new Error('ALREADY_REVIEWED');
            const driverId = row.driver_id;
            const changes = row.requested_changes ?? {};
            // Mark the queued payout card (if any) as REJECTED with the same reason.
            if (changes.payout_card_id) {
                await client.query(`UPDATE payout_cards SET status = 'REJECTED', rejected_at = NOW(), rejection_reason = $1 WHERE id = $2 AND driver_id = $3`, [reason, changes.payout_card_id, driverId]);
            }
            // Mark request REJECTED.
            await client.query(`UPDATE profile_change_requests SET status = 'REJECTED', reviewed_at = NOW(), reviewed_by_admin_id = $1, rejection_reason = $2 WHERE id = $3`, [adminId, reason, id]);
            // Restore the driver's previous state (snapshot taken at submission time).
            // prev_is_active / prev_bg_status may be null for legacy rows; fall back
            // to "still approved" if the snapshot says so, or stay PENDING/INACTIVE otherwise.
            const prevIsActive = row.prev_is_active ?? false;
            const prevBgStatus = row.prev_bg_status ?? 'PENDING';
            await client.query(`UPDATE drivers SET is_active = $1, background_check_status = $2 WHERE user_id = $3`, [prevIsActive, prevBgStatus, driverId]);
            await client.query(`INSERT INTO audit_logs (admin_id, target_id, action, details) VALUES ($1, $2, 'PROFILE_CHANGE_REJECTED', $3)`, [adminId, driverId, JSON.stringify({ request_id: id, reason })]);
            await client.query('COMMIT');
            try {
                await email_service_1.EmailService.sendProfileChangeRejectedEmail({ email: row.email, full_name: row.full_name }, reason);
            }
            catch (e) {
                console.warn('[ADMIN] ⚠️ Rejected email failed:', e.message);
            }
            res.json({ status: 'REJECTED' });
        }
        catch (error) {
            await client.query('ROLLBACK');
            const code = error.message === 'NOT_FOUND' ? 404
                : error.message === 'ALREADY_REVIEWED' ? 409
                    : 400;
            console.error(`[ADMIN] ❌ Reject profile change error: ${error.message}`);
            res.status(code).json({ error: error.message || 'Failed to reject profile change.' });
        }
        finally {
            client.release();
        }
    }
    // ============================================================
    // Payout cards (020)
    // ============================================================
    static async listPayoutCards(req, res) {
        try {
            const { status = 'PENDING', limit = '50', offset = '0' } = req.query;
            const lim = Math.min(parseInt(String(limit), 10) || 50, 200);
            const off = Math.max(parseInt(String(offset), 10) || 0, 0);
            const res0 = await database_1.pool.query(`SELECT pc.id, pc.driver_id, pc.brand, pc.last4, pc.exp_month, pc.exp_year, pc.cardholder_name, pc.zip,
                pc.status, pc.created_at, pc.approved_at, pc.rejected_at, pc.rejection_reason,
                u.full_name, u.email
         FROM payout_cards pc
         JOIN users u ON u.id = pc.driver_id
         WHERE pc.status = $1
         ORDER BY pc.created_at DESC
         LIMIT $2 OFFSET $3`, [status, lim, off]);
            const total = await database_1.pool.query(`SELECT COUNT(*)::int AS c FROM payout_cards WHERE status = $1`, [status]);
            res.json({ cards: res0.rows, total: total.rows[0]?.c ?? 0 });
        }
        catch (error) {
            console.error(`[ADMIN] ❌ List payout cards error: ${error.message}`);
            res.status(500).json({ error: 'Failed to list payout cards.' });
        }
    }
    static async approvePayoutCard(req, res) {
        const { id } = req.params;
        const adminId = req.user.id;
        const client = await database_1.pool.connect();
        try {
            await client.query('BEGIN');
            const lock = await client.query(`SELECT pc.*, u.email, u.full_name FROM payout_cards pc
         JOIN users u ON u.id = pc.driver_id
         WHERE pc.id = $1 FOR UPDATE`, [id]);
            if (!lock.rowCount)
                throw new Error('NOT_FOUND');
            const row = lock.rows[0];
            if (row.status !== 'PENDING')
                throw new Error('ALREADY_REVIEWED');
            await client.query(`UPDATE payout_cards SET status = 'APPROVED', approved_at = NOW() WHERE id = $1`, [id]);
            await client.query(`INSERT INTO driver_wallets (driver_id, payout_card_id) VALUES ($1, $2)
         ON CONFLICT (driver_id) DO UPDATE SET payout_card_id = EXCLUDED.payout_card_id, updated_at = NOW()`, [row.driver_id, id]);
            await client.query(`INSERT INTO audit_logs (admin_id, target_id, action, details) VALUES ($1, $2, 'PAYOUT_CARD_APPROVED', $3)`, [adminId, row.driver_id, JSON.stringify({ card_id: id, brand: row.brand, last4: row.last4 })]);
            await client.query('COMMIT');
            res.json({ status: 'APPROVED' });
        }
        catch (error) {
            await client.query('ROLLBACK');
            const code = error.message === 'NOT_FOUND' ? 404
                : error.message === 'ALREADY_REVIEWED' ? 409
                    : 400;
            console.error(`[ADMIN] ❌ Approve payout card error: ${error.message}`);
            res.status(code).json({ error: error.message || 'Failed to approve payout card.' });
        }
        finally {
            client.release();
        }
    }
    static async rejectPayoutCard(req, res) {
        const { id } = req.params;
        const { reason } = req.body;
        const adminId = req.user.id;
        if (!reason || !String(reason).trim())
            return res.status(400).json({ error: 'A rejection reason is required.' });
        const client = await database_1.pool.connect();
        try {
            await client.query('BEGIN');
            const lock = await client.query(`SELECT pc.*, u.email, u.full_name FROM payout_cards pc
         JOIN users u ON u.id = pc.driver_id
         WHERE pc.id = $1 FOR UPDATE`, [id]);
            if (!lock.rowCount)
                throw new Error('NOT_FOUND');
            const row = lock.rows[0];
            if (row.status !== 'PENDING')
                throw new Error('ALREADY_REVIEWED');
            await client.query(`UPDATE payout_cards SET status = 'REJECTED', rejected_at = NOW(), rejection_reason = $1 WHERE id = $2`, [reason, id]);
            await client.query(`INSERT INTO audit_logs (admin_id, target_id, action, details) VALUES ($1, $2, 'PAYOUT_CARD_REJECTED', $3)`, [adminId, row.driver_id, JSON.stringify({ card_id: id, reason })]);
            await client.query('COMMIT');
            res.json({ status: 'REJECTED' });
        }
        catch (error) {
            await client.query('ROLLBACK');
            const code = error.message === 'NOT_FOUND' ? 404
                : error.message === 'ALREADY_REVIEWED' ? 409
                    : 400;
            console.error(`[ADMIN] ❌ Reject payout card error: ${error.message}`);
            res.status(code).json({ error: error.message || 'Failed to reject payout card.' });
        }
        finally {
            client.release();
        }
    }
    // ============================================================
    // Payouts (020)
    // ============================================================
    static async listPayouts(req, res) {
        try {
            const { status, method, limit = '50', offset = '0' } = req.query;
            const lim = Math.min(parseInt(String(limit), 10) || 50, 200);
            const off = Math.max(parseInt(String(offset), 10) || 0, 0);
            const where = [];
            const vals = [];
            let i = 1;
            if (status) {
                where.push(`p.status = $${i++}`);
                vals.push(status);
            }
            if (method) {
                where.push(`p.method = $${i++}`);
                vals.push(method);
            }
            const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
            vals.push(lim, off);
            const res0 = await database_1.pool.query(`SELECT p.*, u.full_name, u.email
         FROM payouts p
         JOIN users u ON u.id = p.driver_id
         ${whereClause}
         ORDER BY p.requested_at DESC
         LIMIT $${i++} OFFSET $${i++}`, vals);
            const totalRes = await database_1.pool.query(`SELECT COUNT(*)::int AS c FROM payouts ${whereClause}`, vals.slice(0, vals.length - 2));
            res.json({ payouts: res0.rows, total: totalRes.rows[0]?.c ?? 0 });
        }
        catch (error) {
            console.error(`[ADMIN] ❌ List payouts error: ${error.message}`);
            res.status(500).json({ error: 'Failed to list payouts.' });
        }
    }
    static async markPayoutPaid(req, res) {
        const { id } = req.params;
        const { reference, notes } = req.body;
        const adminId = req.user.id;
        if (!reference || !String(reference).trim())
            return res.status(400).json({ error: 'A payment reference is required.' });
        const client = await database_1.pool.connect();
        try {
            await client.query('BEGIN');
            const lock = await client.query(`SELECT p.*, u.email, u.full_name FROM payouts p
         JOIN users u ON u.id = p.driver_id
         WHERE p.id = $1 FOR UPDATE`, [id]);
            if (!lock.rowCount)
                throw new Error('NOT_FOUND');
            const row = lock.rows[0];
            if (row.status === 'PAID')
                throw new Error('ALREADY_PAID');
            await client.query(`UPDATE payouts SET status = 'PAID', processed_at = NOW(), reference = $1, notes = $2 WHERE id = $3`, [reference, notes ?? null, id]);
            await client.query(`INSERT INTO audit_logs (admin_id, target_id, action, details) VALUES ($1, $2, 'PAYOUT_PAID', $3)`, [adminId, row.driver_id, JSON.stringify({ payout_id: id, amount_cents: row.amount_cents, net_cents: row.net_cents, reference })]);
            await client.query('COMMIT');
            try {
                await email_service_1.EmailService.sendPayoutReceiptEmail({ email: row.email, full_name: row.full_name }, { id, amount_cents: Number(row.amount_cents), fee_cents: Number(row.fee_cents), net_cents: Number(row.net_cents), reference });
            }
            catch (e) {
                console.warn('[ADMIN] ⚠️ Payout receipt email failed:', e.message);
            }
            res.json({ status: 'PAID' });
        }
        catch (error) {
            await client.query('ROLLBACK');
            const code = error.message === 'NOT_FOUND' ? 404
                : error.message === 'ALREADY_PAID' ? 409
                    : 400;
            console.error(`[ADMIN] ❌ Mark payout paid error: ${error.message}`);
            res.status(code).json({ error: error.message || 'Failed to mark payout paid.' });
        }
        finally {
            client.release();
        }
    }
}
exports.AdminController = AdminController;
//# sourceMappingURL=admin.controller.js.map