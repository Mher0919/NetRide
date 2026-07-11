import { Response } from 'express';
import { prisma } from '../../services/prisma.service';
import { AuthRequest } from '../../middleware/auth.middleware';
import { VerificationStatus, UserRole } from '@prisma/client';
import { pool } from '../../config/database';
import { SpeedingDetector } from '../../services/speeding_detector';
import { EmailService } from '../../services/email.service';

export class AdminController {
  static async getStats(req: AuthRequest, res: Response) {
    try {
      const [totalRiders, totalDrivers, pendingVerifications, verifiedUsers, rejectedUsers] = await Promise.all([
        prisma.user.count({ where: { role: UserRole.RIDER } }),
        prisma.user.count({ where: { driver_profile: { isNot: null } } }),
        prisma.user.count({ where: { verification_status: VerificationStatus.PENDING } }),
        prisma.user.count({ where: { verification_status: VerificationStatus.VERIFIED } }),
        prisma.user.count({ where: { verification_status: VerificationStatus.REJECTED } }),
      ]);

      res.json({
        totalRiders,
        totalDrivers,
        pendingVerifications,
        verifiedUsers,
        rejectedUsers,
      });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Stats error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve administrative statistics.' });
    }
  }

  static async getUsers(req: AuthRequest, res: Response) {
    const { role, status, search, page = 1, limit = 10, dangerousOnly } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {};
    if (role) {
      // Support dual-role users: "DRIVER" means has a driver profile,
      // "RIDER" means the original sign-up role.
      if (role === 'DRIVER') {
        where.driver_profile = { isNot: null };
      } else {
        where.role = role as UserRole;
      }
    }
    if (status) where.verification_status = status as VerificationStatus;
    if (search) {
      where.OR = [
        { full_name: { contains: search as string, mode: 'insensitive' } },
        { email: { contains: search as string, mode: 'insensitive' } },
        { phone_number: { contains: search as string, mode: 'insensitive' } },
      ];
    }
    if (dangerousOnly === 'true') {
      where.driver_profile = { is: { is_dangerous: true } };
    }

    try {
      const [users, total] = await Promise.all([
        prisma.user.findMany({
          where,
          skip,
          take: Number(limit),
          orderBy: { created_at: 'desc' },
          include: {
            driver_profile: true,
          },
        }),
        prisma.user.count({ where }),
      ]);

      res.json({
        users,
        total,
        page: Number(page),
        totalPages: Math.ceil(total / Number(limit)),
      });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Get users error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve user list.' });
    }
  }

  static async getUserById(req: AuthRequest, res: Response) {
    const { id } = req.params;
    try {
      const user = await prisma.user.findUnique({
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
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Get user detail error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve user details.' });
    }
  }

  static async verifyUser(req: AuthRequest, res: Response) {
    const { id } = req.params;
    const adminId = req.user!.id;
    try {
      const user = await (prisma.user as any).update({
        where: { id },
        data: {
          verification_status: VerificationStatus.VERIFIED,
          is_verified: true,
          verification_feedback_seen: false
        },
      });

      const hasDriverProfile = await prisma.driver.findUnique({ where: { user_id: id } });
      if (hasDriverProfile) {
        await (prisma.driver as any).update({
          where: { user_id: id },
          data: {
            background_check_status: 'APPROVED',
            is_active: true,
            verification_feedback_seen: false
          },
        });
      }

      await prisma.auditLog.create({
        data: {
          admin_id: adminId,
          target_id: id,
          action: 'VERIFY',
          details: `User ${user.email} verified by admin.`,
        },
      });

      res.json({ message: 'User verified successfully', user });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Verify user error: ${error.message}`);
      res.status(500).json({ error: 'Failed to verify user.' });
    }
  }

  static async rejectUser(req: AuthRequest, res: Response) {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.user!.id;

    if (!reason) return res.status(400).json({ error: 'A rejection reason is required.' });

    try {
      const user = await (prisma.user as any).update({
        where: { id },
        data: {
          verification_status: VerificationStatus.REJECTED,
          is_verified: false,
          rejection_reason: reason,
          verification_feedback_seen: false
        },
      });

      const hasDriverProfile = await prisma.driver.findUnique({ where: { user_id: id } });
      if (hasDriverProfile) {
        await (prisma.driver as any).update({
          where: { user_id: id },
          data: {
            background_check_status: 'REJECTED',
            is_active: false,
            rejection_reason: reason,
            verification_feedback_seen: false
          },
        });
      }

      await prisma.auditLog.create({
        data: {
          admin_id: adminId,
          target_id: id,
          action: 'REJECT',
          details: `User ${user.email} rejected. Reason: ${reason}`,
        },
      });

      res.json({ message: 'User rejected', user });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Reject user error: ${error.message}`);
      res.status(500).json({ error: 'Failed to reject user.' });
    }
  }

  static async setPending(req: AuthRequest, res: Response) {
    const { id } = req.params;
    const adminId = req.user!.id;
    try {
      const user = await prisma.user.update({
        where: { id },
        data: {
          verification_status: VerificationStatus.PENDING,
          is_verified: false,
        },
      });

      const hasDriverProfile = await prisma.driver.findUnique({ where: { user_id: id } });
      if (hasDriverProfile) {
        await prisma.driver.update({
          where: { user_id: id },
          data: {
            background_check_status: 'PENDING',
            is_active: false,
          },
        });
      }

      await prisma.auditLog.create({
        data: {
          admin_id: adminId,
          target_id: id,
          action: 'SET_PENDING',
          details: `User ${user.email} set back to pending.`,
        },
      });

      res.json({ message: 'User status set to pending', user });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Set pending error: ${error.message}`);
      res.status(500).json({ error: 'Failed to update user status.' });
    }
  }

  static async getLogs(req: AuthRequest, res: Response) {
    const { page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    try {
      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          skip,
          take: Number(limit),
          orderBy: { created_at: 'desc' },
          include: {
            admin: { select: { full_name: true, email: true } },
            target: { select: { full_name: true, email: true } },
          },
        }),
        prisma.auditLog.count(),
      ]);

      res.json({
        logs,
        total,
        page: Number(page),
        totalPages: Math.ceil(total / Number(limit)),
      });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Get logs error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve audit logs.' });
    }
  }

  static async getRides(req: AuthRequest, res: Response) {
    const { status, page = 1, limit = 10 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {};
    if (status) {
      if (status === 'ACTIVE') {
        where.status = { notIn: ['COMPLETED', 'CANCELLED'] };
      } else if (status === 'COMPLETED') {
        where.status = 'COMPLETED';
      } else {
        where.status = status;
      }
    }

    try {
      const [rides, total] = await Promise.all([
        prisma.ride.findMany({
          where,
          skip,
          take: Number(limit),
          orderBy: { created_at: 'desc' },
          include: {
            rider: { select: { full_name: true, email: true, phone_number: true } },
            driver: { select: { full_name: true, email: true, phone_number: true } },
          },
        }),
        prisma.ride.count({ where }),
      ]);

      res.json({
        rides,
        total,
        page: Number(page),
        totalPages: Math.ceil(total / Number(limit)),
      });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Get rides error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve ride list.' });
    }
  }

  static async getRideById(req: AuthRequest, res: Response) {
    const { id } = req.params;
    try {
      const ride = await prisma.ride.findUnique({
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

      if (!ride) return res.status(404).json({ error: 'Ride not found.' });

      res.json(ride);
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Get ride detail error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve ride details.' });
    }
  }

  static async verifyInspection(req: AuthRequest, res: Response) {
    const { vehicleId } = req.params;
    const { status, notes, expiryDate } = req.body;
    const adminId = req.user!.id;

    try {
      const vehicle = await (prisma as any).driverVehicle.update({
        where: { id: vehicleId },
        data: {
          inspection_status: status,
          inspection_notes: notes,
          inspection_expiry_date: expiryDate ? new Date(expiryDate) : undefined
        }
      });

      if (status === 'REJECTED') {
          await (prisma.driver as any).update({
              where: { user_id: vehicle.driver_id },
              data: {
                  rejection_reason: notes || 'Vehicle inspection failed.',
                  verification_feedback_seen: false
              }
          });
      } else if (status === 'APPROVED') {
          await (prisma.driver as any).update({
              where: { user_id: vehicle.driver_id },
              data: {
                  verification_feedback_seen: false
              }
          });
      }

      await prisma.auditLog.create({
        data: {
          admin_id: adminId,
          target_id: vehicle.driver_id,
          action: `INSPECTION_${status}`,
          details: `Vehicle ${vehicle.license_plate_number} inspection status updated to ${status}. Notes: ${notes || 'None'}`,
        },
      });

      res.json({ message: 'Inspection status updated successfully', vehicle });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Verify inspection error: ${error.message}`);
      res.status(500).json({ error: 'Failed to update inspection status.' });
    }
  }

  static async getRideAudit(req: AuthRequest, res: Response) {
    const { id } = req.params;
    try {
      const ride = await prisma.ride.findUnique({
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

      if (!ride) return res.status(404).json({ error: 'Ride not found.' });

      const timeline = [
        { event: 'REQUESTED', time: ride.created_at },
        { event: 'ACCEPTED', time: ride.accepted_at },
        { event: 'STARTED', time: ride.started_at },
        { event: 'COMPLETED', time: ride.completed_at },
        { event: 'CANCELLED', time: ride.cancelled_at }
      ].filter(e => e.time !== null).sort((a, b) => a.time!.getTime() - b.time!.getTime());

      res.json({
        ride_id: (ride as any).id,
        status: (ride as any).status,
        timeline,
        compliance_snapshot: (ride as any).compliance_snapshot,
        ratings: {
          rider_to_driver: (ride as any).rating?.target_role === 'DRIVER' ? (ride as any).rating : null,
          all_ratings: await prisma.rating.findMany({ where: { ride_id: id } })
        }
      });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Get ride audit error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve ride audit.' });
    }
  }

  static async getLiveDrivers(req: AuthRequest, res: Response) {
    try {
      const { redis, DRIVER_LOCATIONS_KEY, DRIVER_HEARTBEAT_PREFIX } = await import('../../config/redis');
      const driverIds = await redis.zrange(DRIVER_LOCATIONS_KEY, 0, -1);
      
      const liveDrivers = [];
      for (const id of driverIds) {
        const [heartbeat, pos, activeTripId] = await Promise.all([
          redis.get(`${DRIVER_HEARTBEAT_PREFIX}${id}`),
          redis.geopos(DRIVER_LOCATIONS_KEY, id),
          redis.get(`driver:${id}:active_trip`)
        ]);

        if (heartbeat && pos && pos[0]) {
          const driver = await prisma.user.findUnique({
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
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Get live drivers error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve live driver status.' });
    }
  }

  /**
   * Fleet-wide view of recent speeding violations, newest first.
   * Used by the /speeding admin dashboard.
   */
  static async getSpeedingViolations(req: AuthRequest, res: Response) {
    try {
      const limit = Math.min(parseInt((req.query.limit as string) || '200', 10), 500);
      const dangerousOnly = req.query.dangerousOnly === 'true';

      const violations = await SpeedingDetector.listRecent(limit);

      // Optional filter: only violations by drivers currently flagged.
      let filtered = violations;
      if (dangerousOnly) {
        const dangerousRes = await pool.query(
          `SELECT user_id FROM drivers WHERE is_dangerous = TRUE`
        );
        const dangerousSet = new Set(dangerousRes.rows.map(r => r.user_id));
        filtered = violations.filter((v: any) => dangerousSet.has(v.driver_id));
      }

      res.json({ violations: filtered, count: filtered.length });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Get speeding violations error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve speeding violations.' });
    }
  }

  /**
   * Per-driver speeding history. Used in UserDetail's Safety section.
   */
  static async getDriverSpeeding(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
      const violations = await SpeedingDetector.listForDriver(id, limit);
      res.json({ violations, count: violations.length });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Get driver speeding error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve driver speeding history.' });
    }
  }

  /**
   * List drivers flagged as dangerous. Includes violation counts so
   * the admin list view can sort by severity.
   */
  static async getDangerousDrivers(req: AuthRequest, res: Response) {
    try {
      const driversRes = await pool.query(
        `SELECT d.user_id, u.full_name, u.email, u.rating,
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
          ORDER BY recent_violation_trips DESC, u.full_name ASC`
      );
      res.json({ drivers: driversRes.rows, count: driversRes.rowCount });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Get dangerous drivers error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve dangerous drivers.' });
    }
  }

  /**
   * Manually clear the dangerous flag after admin review (warning
   * issued, retraining completed, etc). Writes an audit_log row.
   */
  static async clearDangerousFlag(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const notes = (req.body?.notes as string | undefined) ?? null;
      const adminId = req.user!.id;
      await SpeedingDetector.clearDangerousFlag(id, adminId, notes ?? undefined);
      res.json({ success: true, driverId: id });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Clear dangerous flag error: ${error.message}`);
      res.status(500).json({ error: 'Failed to clear dangerous flag.' });
    }
  }

  // ============================================================
  // Profile-change approval queue (020)
  // ============================================================

  static async listProfileChanges(req: AuthRequest, res: Response) {
    try {
      const { status = 'PENDING', limit = '50', offset = '0' } = req.query;
      const lim = Math.min(parseInt(String(limit), 10) || 50, 200);
      const off = Math.max(parseInt(String(offset), 10) || 0, 0);
      const res0 = await pool.query(
        `SELECT pcr.id, pcr.driver_id, pcr.status, pcr.created_at, pcr.reviewed_at, pcr.card_last4, pcr.card_brand,
                pcr.requested_changes,
                u.full_name AS driver_name, u.email AS driver_email
         FROM profile_change_requests pcr
         JOIN users u ON u.id = pcr.driver_id
         WHERE pcr.status = $1
         ORDER BY pcr.created_at DESC
         LIMIT $2 OFFSET $3`,
        [status, lim, off]
      );
      const total = await pool.query(`SELECT COUNT(*)::int AS c FROM profile_change_requests WHERE status = $1`, [status]);
      res.json({ requests: res0.rows, count: total.rows[0]?.c ?? 0 });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ List profile changes error: ${error.message}`);
      res.status(500).json({ error: 'Failed to list profile changes.' });
    }
  }

  static async getProfileChange(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const res0 = await pool.query(
        `SELECT pcr.*, u.full_name, u.email, u.phone_number, u.profile_image_url, u.date_of_birth
         FROM profile_change_requests pcr
         JOIN users u ON u.id = pcr.driver_id
         WHERE pcr.id = $1`,
        [id]
      );
      if (!res0.rowCount) return res.status(404).json({ error: 'Profile change not found.' });
      // Fetch current values for comparison
      const driverId = res0.rows[0].driver_id;
      const driverRes = await pool.query(`SELECT user_id, license_number FROM drivers WHERE user_id = $1`, [driverId]);
      const vehRes = await pool.query(
        `SELECT make, model, year, color, license_plate_number, license_plate_photo_url, inspection_photo_url, car_photo_urls
         FROM driver_vehicles WHERE driver_id = $1 ORDER BY id DESC LIMIT 1`,
        [driverId]
      );
      res.json({
        change: res0.rows[0],
        driver: driverRes.rows[0] ?? null,
        vehicle: vehRes.rows[0] ?? null,
      });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Get profile change error: ${error.message}`);
      res.status(500).json({ error: 'Failed to fetch profile change.' });
    }
  }

  static async approveProfileChange(req: AuthRequest, res: Response) {
    const { id } = req.params;
    const adminId = req.user!.id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query(
        `SELECT pcr.*, u.email, u.full_name FROM profile_change_requests pcr
         JOIN users u ON u.id = pcr.driver_id
         WHERE pcr.id = $1 FOR UPDATE`,
        [id]
      );
      if (!lock.rowCount) throw new Error('NOT_FOUND');
      const row = lock.rows[0];
      if (row.status !== 'PENDING') throw new Error('ALREADY_REVIEWED');

      const driverId: string = row.driver_id;
      const changes: any = row.requested_changes ?? {};
      const updatedFields: string[] = [];

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
      const vehicleSets: string[] = [];
      const vehicleVals: any[] = [];
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
        await client.query(
          `UPDATE driver_vehicles SET ${vehicleSets.join(', ')} WHERE driver_id = $${i}`,
          vehicleVals
        );
      }

      // Payout card: if queued, flip to APPROVED and attach to wallet.
      if (changes.payout_card_id) {
        await client.query(
          `UPDATE payout_cards SET status = 'APPROVED', approved_at = NOW() WHERE id = $1 AND driver_id = $2`,
          [changes.payout_card_id, driverId]
        );
        await client.query(
          `INSERT INTO driver_wallets (driver_id, payout_card_id) VALUES ($1, $2)
           ON CONFLICT (driver_id) DO UPDATE SET payout_card_id = EXCLUDED.payout_card_id, updated_at = NOW()`,
          [driverId, changes.payout_card_id]
        );
        updatedFields.push('payout_card');
      }

      // Mark the request APPROVED + unblock the driver.
      await client.query(
        `UPDATE profile_change_requests SET status = 'APPROVED', reviewed_at = NOW(), reviewed_by_admin_id = $1 WHERE id = $2`,
        [adminId, id]
      );
      await client.query(
        `UPDATE drivers SET is_active = true, background_check_status = 'APPROVED', verification_feedback_seen = false WHERE user_id = $1`,
        [driverId]
      );

      await client.query(
        `INSERT INTO audit_logs (admin_id, target_id, action, details) VALUES ($1, $2, 'PROFILE_CHANGE_APPROVED', $3)`,
        [adminId, driverId, JSON.stringify({ request_id: id, updated_fields: updatedFields })]
      );

      await client.query('COMMIT');

      // Fire-and-forget side effects
      try {
        await EmailService.sendProfileChangeApprovedEmail({ email: row.email, full_name: row.full_name });
      } catch (e: any) { console.warn('[ADMIN] ⚠️ Approved email failed:', e.message); }

      res.json({ status: 'APPROVED', updated_fields: updatedFields });
    } catch (error: any) {
      await client.query('ROLLBACK');
      const code = error.message === 'NOT_FOUND' ? 404
        : error.message === 'ALREADY_REVIEWED' ? 409
        : 400;
      console.error(`[ADMIN] ❌ Approve profile change error: ${error.message}`);
      res.status(code).json({ error: error.message || 'Failed to approve profile change.' });
    } finally {
      client.release();
    }
  }

  static async rejectProfileChange(req: AuthRequest, res: Response) {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.user!.id;
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'A rejection reason is required.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query(
        `SELECT pcr.*, u.email, u.full_name FROM profile_change_requests pcr
         JOIN users u ON u.id = pcr.driver_id
         WHERE pcr.id = $1 FOR UPDATE`,
        [id]
      );
      if (!lock.rowCount) throw new Error('NOT_FOUND');
      const row = lock.rows[0];
      if (row.status !== 'PENDING') throw new Error('ALREADY_REVIEWED');

      const driverId: string = row.driver_id;
      const changes: any = row.requested_changes ?? {};

      // Mark the queued payout card (if any) as REJECTED with the same reason.
      if (changes.payout_card_id) {
        await client.query(
          `UPDATE payout_cards SET status = 'REJECTED', rejected_at = NOW(), rejection_reason = $1 WHERE id = $2 AND driver_id = $3`,
          [reason, changes.payout_card_id, driverId]
        );
      }

      // Mark request REJECTED.
      await client.query(
        `UPDATE profile_change_requests SET status = 'REJECTED', reviewed_at = NOW(), reviewed_by_admin_id = $1, rejection_reason = $2 WHERE id = $3`,
        [adminId, reason, id]
      );

      // Restore the driver's previous state (snapshot taken at submission time).
      // prev_is_active / prev_bg_status may be null for legacy rows; fall back
      // to "still approved" if the snapshot says so, or stay PENDING/INACTIVE otherwise.
      const prevIsActive = row.prev_is_active ?? false;
      const prevBgStatus = row.prev_bg_status ?? 'PENDING';
      await client.query(
        `UPDATE drivers SET is_active = $1, background_check_status = $2 WHERE user_id = $3`,
        [prevIsActive, prevBgStatus, driverId]
      );

      await client.query(
        `INSERT INTO audit_logs (admin_id, target_id, action, details) VALUES ($1, $2, 'PROFILE_CHANGE_REJECTED', $3)`,
        [adminId, driverId, JSON.stringify({ request_id: id, reason })]
      );

      await client.query('COMMIT');

      try {
        await EmailService.sendProfileChangeRejectedEmail({ email: row.email, full_name: row.full_name }, reason);
      } catch (e: any) { console.warn('[ADMIN] ⚠️ Rejected email failed:', e.message); }

      res.json({ status: 'REJECTED' });
    } catch (error: any) {
      await client.query('ROLLBACK');
      const code = error.message === 'NOT_FOUND' ? 404
        : error.message === 'ALREADY_REVIEWED' ? 409
        : 400;
      console.error(`[ADMIN] ❌ Reject profile change error: ${error.message}`);
      res.status(code).json({ error: error.message || 'Failed to reject profile change.' });
    } finally {
      client.release();
    }
  }

  // ============================================================
  // Payout cards (020)
  // ============================================================

  static async listPayoutCards(req: AuthRequest, res: Response) {
    try {
      const { status = 'PENDING', limit = '50', offset = '0' } = req.query;
      const lim = Math.min(parseInt(String(limit), 10) || 50, 200);
      const off = Math.max(parseInt(String(offset), 10) || 0, 0);
      const res0 = await pool.query(
        `SELECT pc.id, pc.driver_id, pc.brand, pc.last4, pc.exp_month, pc.exp_year, pc.cardholder_name, pc.zip,
                pc.status, pc.created_at, pc.approved_at, pc.rejected_at, pc.rejection_reason,
                u.full_name, u.email
         FROM payout_cards pc
         JOIN users u ON u.id = pc.driver_id
         WHERE pc.status = $1
         ORDER BY pc.created_at DESC
         LIMIT $2 OFFSET $3`,
        [status, lim, off]
      );
      const total = await pool.query(`SELECT COUNT(*)::int AS c FROM payout_cards WHERE status = $1`, [status]);
      res.json({ cards: res0.rows, total: total.rows[0]?.c ?? 0 });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ List payout cards error: ${error.message}`);
      res.status(500).json({ error: 'Failed to list payout cards.' });
    }
  }

  static async approvePayoutCard(req: AuthRequest, res: Response) {
    const { id } = req.params;
    const adminId = req.user!.id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query(
        `SELECT pc.*, u.email, u.full_name FROM payout_cards pc
         JOIN users u ON u.id = pc.driver_id
         WHERE pc.id = $1 FOR UPDATE`,
        [id]
      );
      if (!lock.rowCount) throw new Error('NOT_FOUND');
      const row = lock.rows[0];
      if (row.status !== 'PENDING') throw new Error('ALREADY_REVIEWED');

      await client.query(`UPDATE payout_cards SET status = 'APPROVED', approved_at = NOW() WHERE id = $1`, [id]);
      await client.query(
        `INSERT INTO driver_wallets (driver_id, payout_card_id) VALUES ($1, $2)
         ON CONFLICT (driver_id) DO UPDATE SET payout_card_id = EXCLUDED.payout_card_id, updated_at = NOW()`,
        [row.driver_id, id]
      );
      await client.query(
        `INSERT INTO audit_logs (admin_id, target_id, action, details) VALUES ($1, $2, 'PAYOUT_CARD_APPROVED', $3)`,
        [adminId, row.driver_id, JSON.stringify({ card_id: id, brand: row.brand, last4: row.last4 })]
      );
      await client.query('COMMIT');
      res.json({ status: 'APPROVED' });
    } catch (error: any) {
      await client.query('ROLLBACK');
      const code = error.message === 'NOT_FOUND' ? 404
        : error.message === 'ALREADY_REVIEWED' ? 409
        : 400;
      console.error(`[ADMIN] ❌ Approve payout card error: ${error.message}`);
      res.status(code).json({ error: error.message || 'Failed to approve payout card.' });
    } finally {
      client.release();
    }
  }

  static async rejectPayoutCard(req: AuthRequest, res: Response) {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.user!.id;
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'A rejection reason is required.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query(
        `SELECT pc.*, u.email, u.full_name FROM payout_cards pc
         JOIN users u ON u.id = pc.driver_id
         WHERE pc.id = $1 FOR UPDATE`,
        [id]
      );
      if (!lock.rowCount) throw new Error('NOT_FOUND');
      const row = lock.rows[0];
      if (row.status !== 'PENDING') throw new Error('ALREADY_REVIEWED');

      await client.query(
        `UPDATE payout_cards SET status = 'REJECTED', rejected_at = NOW(), rejection_reason = $1 WHERE id = $2`,
        [reason, id]
      );
      await client.query(
        `INSERT INTO audit_logs (admin_id, target_id, action, details) VALUES ($1, $2, 'PAYOUT_CARD_REJECTED', $3)`,
        [adminId, row.driver_id, JSON.stringify({ card_id: id, reason })]
      );
      await client.query('COMMIT');
      res.json({ status: 'REJECTED' });
    } catch (error: any) {
      await client.query('ROLLBACK');
      const code = error.message === 'NOT_FOUND' ? 404
        : error.message === 'ALREADY_REVIEWED' ? 409
        : 400;
      console.error(`[ADMIN] ❌ Reject payout card error: ${error.message}`);
      res.status(code).json({ error: error.message || 'Failed to reject payout card.' });
    } finally {
      client.release();
    }
  }

  // ============================================================
  // Payouts (020)
  // ============================================================

  static async listPayouts(req: AuthRequest, res: Response) {
    try {
      const { status, method, limit = '50', offset = '0' } = req.query;
      const lim = Math.min(parseInt(String(limit), 10) || 50, 200);
      const off = Math.max(parseInt(String(offset), 10) || 0, 0);
      const where: string[] = [];
      const vals: any[] = [];
      let i = 1;
      if (status) { where.push(`p.status = $${i++}`); vals.push(status); }
      if (method) { where.push(`p.method = $${i++}`); vals.push(method); }
      const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      vals.push(lim, off);
      const res0 = await pool.query(
        `SELECT p.*, u.full_name, u.email
         FROM payouts p
         JOIN users u ON u.id = p.driver_id
         ${whereClause}
         ORDER BY p.requested_at DESC
         LIMIT $${i++} OFFSET $${i++}`,
        vals
      );
      const totalRes = await pool.query(`SELECT COUNT(*)::int AS c FROM payouts ${whereClause}`, vals.slice(0, vals.length - 2));
      res.json({ payouts: res0.rows, total: totalRes.rows[0]?.c ?? 0 });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ List payouts error: ${error.message}`);
      res.status(500).json({ error: 'Failed to list payouts.' });
    }
  }

  static async markPayoutPaid(req: AuthRequest, res: Response) {
    const { id } = req.params;
    const { reference, notes } = req.body;
    const adminId = req.user!.id;
    if (!reference || !String(reference).trim()) return res.status(400).json({ error: 'A payment reference is required.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query(
        `SELECT p.*, u.email, u.full_name FROM payouts p
         JOIN users u ON u.id = p.driver_id
         WHERE p.id = $1 FOR UPDATE`,
        [id]
      );
      if (!lock.rowCount) throw new Error('NOT_FOUND');
      const row = lock.rows[0];
      if (row.status === 'PAID') throw new Error('ALREADY_PAID');

      await client.query(
        `UPDATE payouts SET status = 'PAID', processed_at = NOW(), reference = $1, notes = $2 WHERE id = $3`,
        [reference, notes ?? null, id]
      );
      await client.query(
        `INSERT INTO audit_logs (admin_id, target_id, action, details) VALUES ($1, $2, 'PAYOUT_PAID', $3)`,
        [adminId, row.driver_id, JSON.stringify({ payout_id: id, amount_cents: row.amount_cents, net_cents: row.net_cents, reference })]
      );
      await client.query('COMMIT');

      try {
        await EmailService.sendPayoutReceiptEmail(
          { email: row.email, full_name: row.full_name },
          { id, amount_cents: Number(row.amount_cents), fee_cents: Number(row.fee_cents), net_cents: Number(row.net_cents), reference }
        );
      } catch (e: any) { console.warn('[ADMIN] ⚠️ Payout receipt email failed:', e.message); }

      res.json({ status: 'PAID' });
    } catch (error: any) {
      await client.query('ROLLBACK');
      const code = error.message === 'NOT_FOUND' ? 404
        : error.message === 'ALREADY_PAID' ? 409
        : 400;
      console.error(`[ADMIN] ❌ Mark payout paid error: ${error.message}`);
      res.status(code).json({ error: error.message || 'Failed to mark payout paid.' });
    } finally {
      client.release();
    }
  }
}
