import { Response } from 'express';
import { prisma } from '../../services/prisma.service';
import { AuthRequest } from '../../middleware/auth.middleware';
import { VerificationStatus, UserRole } from '@prisma/client';
import { pool } from '../../config/database';
import { SpeedingDetector } from '../../services/speeding_detector';
import { EmailService } from '../../services/email.service';
import { StorageService } from '../../services/storage.service';
import { io } from '../../app';
import {
  getProfiles,
  getConfig,
  getRevenueConfig,
  getRevenueSummary,
  invalidateRevenueCache,
} from '../../services/pricing.service';
import { ReportService } from '../reporting/report.service';
import { reportReasonLabel, PartyRole } from '../reporting/report.reasons';
import { FinancialLedgerService } from '../../services/financial-ledger.service';
import { AuditEventsService } from '../../services/audit-events.service';

export class AdminController {
  private static toJSON(value: any): any {
    if (typeof value === 'bigint') return Number(value);
    if (Array.isArray(value)) return value.map((v) => AdminController.toJSON(v));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, any> = {};
      for (const [key, val] of Object.entries(value)) out[key] = AdminController.toJSON(val);
      return out;
    }
    return value;
  }

  static async getStats(req: AuthRequest, res: Response) {
    try {
      const [totalRiders, totalDrivers, pendingVerifications, verifiedUsers, rejectedUsers, pendingDocumentReviews] = await Promise.all([
        prisma.user.count({ where: { role: UserRole.RIDER } }),
        prisma.user.count({ where: { driver_profile: { isNot: null } } }),
        prisma.user.count({ where: { verification_status: VerificationStatus.PENDING } }),
        prisma.user.count({ where: { verification_status: VerificationStatus.VERIFIED } }),
        prisma.user.count({ where: { verification_status: VerificationStatus.REJECTED } }),
        pool.query(`SELECT COUNT(*)::int AS c FROM driver_document_requirements WHERE status = 'submitted'`),
      ]);

      res.json({
        totalRiders,
        totalDrivers,
        pendingVerifications,
        verifiedUsers,
        rejectedUsers,
        pendingDocumentReviews: pendingDocumentReviews.rows[0].c,
      });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Stats error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve administrative statistics.' });
    }
  }

  // ============================================================
  // Fleet partner management (041) — revenue split configuration
  // ============================================================

  static async listFleets(req: AuthRequest, res: Response) {
    try {
      const fleets = await pool.query(
        `SELECT f.*,
                COUNT(d.user_id)::int AS driver_count,
                COALESCE(SUM((s.fleet_allocations->0->>'cents')::bigint), 0)::bigint AS fleet_earnings_cents
         FROM fleet_partners f
         LEFT JOIN drivers d ON d.fleet_id = f.id
         LEFT JOIN ride_price_snapshots s ON s.driver_fleet_id = f.id
         GROUP BY f.id
         ORDER BY f.name`,
      );
      res.json({ fleets: fleets.rows });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Fleet list error: ${error.message}`);
      res.status(500).json({ error: 'Failed to list fleet partners.' });
    }
  }

  static async createFleet(req: AuthRequest, res: Response) {
    const { name, platform_share_percent, contact_name, contact_email, notes } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Fleet name is required.' });
    }
    const share = Number(platform_share_percent ?? 0);
    if (!Number.isFinite(share) || share < 0 || share > 100) {
      return res.status(400).json({ error: 'platform_share_percent must be between 0 and 100.' });
    }
    try {
      const ins = await pool.query(
        `INSERT INTO fleet_partners (name, platform_share_percent, contact_name, contact_email, notes)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [String(name).trim(), share, contact_name ?? null, contact_email ?? null, notes ?? null],
      );
      invalidateRevenueCache();
      res.status(201).json({ fleet: ins.rows[0] });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Fleet create error: ${error.message}`);
      res.status(500).json({ error: 'Failed to create fleet partner.' });
    }
  }

  static async updateFleet(req: AuthRequest, res: Response) {
    const { id } = req.params;
    const { name, platform_share_percent, is_active, contact_name, contact_email, notes } = req.body;
    try {
      const fields: string[] = [];
      const values: any[] = [];
      let i = 1;
      if (name !== undefined) {
        if (!String(name).trim()) return res.status(400).json({ error: 'Fleet name cannot be empty.' });
        fields.push(`name = $${i++}`);
        values.push(String(name).trim());
      }
      if (platform_share_percent !== undefined) {
        const share = Number(platform_share_percent);
        if (!Number.isFinite(share) || share < 0 || share > 100) {
          return res.status(400).json({ error: 'platform_share_percent must be between 0 and 100.' });
        }
        fields.push(`platform_share_percent = $${i++}`);
        values.push(share);
      }
      if (is_active !== undefined) {
        fields.push(`is_active = $${i++}`);
        values.push(is_active === true || is_active === 'true');
      }
      if (contact_name !== undefined) { fields.push(`contact_name = $${i++}`); values.push(contact_name ?? null); }
      if (contact_email !== undefined) { fields.push(`contact_email = $${i++}`); values.push(contact_email ?? null); }
      if (notes !== undefined) { fields.push(`notes = $${i++}`); values.push(notes ?? null); }
      if (fields.length === 0) return res.status(400).json({ error: 'No fields to update.' });

      fields.push(`updated_at = NOW()`);
      values.push(id);
      const upd = await pool.query(
        `UPDATE fleet_partners SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
        values,
      );
      if (!upd.rowCount) return res.status(404).json({ error: 'Fleet partner not found.' });
      invalidateRevenueCache();
      res.json({ fleet: upd.rows[0] });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Fleet update error: ${error.message}`);
      res.status(500).json({ error: 'Failed to update fleet partner.' });
    }
  }

  /** Assign (fleet_id) or unassign (null) a driver to/from a fleet. */
  static async assignDriverFleet(req: AuthRequest, res: Response) {
    const { id } = req.params;
    const { fleet_id } = req.body;
    try {
      if (fleet_id !== null) {
        const fleet = await pool.query(`SELECT 1 FROM fleet_partners WHERE id = $1`, [fleet_id]);
        if (!fleet.rowCount) return res.status(400).json({ error: 'Unknown fleet partner.' });
      }
      const upd = await pool.query(
        `UPDATE drivers SET fleet_id = $1 WHERE user_id = $2 RETURNING user_id, fleet_id`,
        [fleet_id ?? null, id],
      );
      if (!upd.rowCount) return res.status(404).json({ error: 'Driver not found.' });
      res.json({ driver_id: id, fleet_id: upd.rows[0].fleet_id });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Fleet assignment error: ${error.message}`);
      res.status(500).json({ error: 'Failed to assign driver to fleet.' });
    }
  }

  // ============================================================
  // Pricing + revenue visibility (041)
  // ============================================================

  static async listPricingProfiles(req: AuthRequest, res: Response) {
    try {
      const profiles = await getProfiles();
      res.json({ profiles });
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to list pricing profiles.' });
    }
  }

  /** Update a profile's rates; the 60s engine cache is busted immediately. */
  static async updatePricingProfile(req: AuthRequest, res: Response) {
    const { code } = req.params;
    const body = req.body;
    const numberKeys = [
      'base_fare', 'per_mile_rate', 'per_minute_rate', 'minimum_fare',
      'booking_fee', 'service_fee_rate', 'tax_rate',
      'max_demand_multiplier', 'peak_time_multiplier', 'off_peak_multiplier',
      'weather_multiplier', 'location_multiplier', 'fleet_multiplier',
    ];
    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    for (const key of numberKeys) {
      if (body[key] === undefined) continue;
      const v = Number(body[key]);
      if (!Number.isFinite(v) || v < 0) {
        return res.status(400).json({ error: `${key} must be a non-negative number.` });
      }
      fields.push(`${key} = $${i++}`);
      values.push(v);
    }
    if (body.label !== undefined) {
      fields.push(`label = $${i++}`);
      values.push(String(body.label));
    }
    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update.' });

    try {
      fields.push(`updated_at = NOW()`);
      values.push(String(code).toUpperCase());
      const upd = await pool.query(
        `UPDATE pricing_profiles SET ${fields.join(', ')} WHERE code = $${i} AND active = TRUE RETURNING *`,
        values,
      );
      if (!upd.rowCount) return res.status(404).json({ error: 'Pricing profile not found.' });
      // Bust the in-memory cache so the next estimate uses the new rates.
      await getConfig(String(code).toUpperCase(), true);
      res.json({ profile: upd.rows[0] });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Pricing update error: ${error.message}`);
      res.status(500).json({ error: 'Failed to update pricing profile.' });
    }
  }

  static async getRevenueOverview(req: AuthRequest, res: Response) {
    try {
      const [config, summary] = await Promise.all([getRevenueConfig(), getRevenueSummary()]);
      res.json({ revenue_config: config, ...summary });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Revenue overview error: ${error.message}`);
      res.status(500).json({ error: 'Failed to load revenue overview.' });
    }
  }

  static async getUsers(req: AuthRequest, res: Response) {
    const { role, status, search, page = 1, limit = 10, dangerousOnly, documentPending, includeTest } = req.query;
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
    // Test users are auto-generated E2E accounts (@test.netride). They flood
    // the first pages (sorted by created_at DESC) and bury real users, so
    // they are hidden by default; admins opt in with includeTest=true.
    if (includeTest !== 'true') {
      where.NOT = { email: { endsWith: '@test.netride' } };
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
      let users: any[];
      let total: number;

      if (documentPending === 'true') {
        // Filter by drivers with pending document reviews
        const pendingDriverIds = await pool.query(
          `SELECT DISTINCT driver_id FROM driver_document_requirements WHERE status = 'submitted'`
        );
        const ids = pendingDriverIds.rows.map((r: any) => r.driver_id);
        if (ids.length === 0) {
          res.json({ users: [], total: 0, page: Number(page), totalPages: 0 });
          return;
        }
        where.id = { in: ids };
        [users, total] = await Promise.all([
          prisma.user.findMany({
            where,
            skip,
            take: Number(limit),
            orderBy: { created_at: 'desc' },
            include: { driver_profile: true },
          }),
          prisma.user.count({ where }),
        ]);
      } else {
        [users, total] = await Promise.all([
          prisma.user.findMany({
            where,
            skip,
            take: Number(limit),
            orderBy: { created_at: 'desc' },
            include: { driver_profile: true },
          }),
          prisma.user.count({ where }),
        ]);

        // Attach pending document review status for each returned user
        if (users.length > 0) {
          const userIds = users.map((u: any) => u.id);
          const placeholders = userIds.map((_, i) => `$${i + 1}`).join(',');
          const pendingReqs = await pool.query(
            `SELECT DISTINCT driver_id FROM driver_document_requirements
             WHERE driver_id IN (${placeholders}) AND status = 'submitted'`,
            userIds
          );
          const pendingIds = new Set(pendingReqs.rows.map((r: any) => r.driver_id));
          users = users.map((u: any) => ({
            ...u,
            has_pending_document_review: pendingIds.has(u.id),
          }));
        }
      }

      res.json(AdminController.toJSON({
        users,
        total,
        page: Number(page),
        totalPages: Math.ceil(total / Number(limit)),
      }));
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Get users error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve user list.' });
    }
  }

  /**
   * Admin view of a driver's ride eligibility. NetRide operates a single
   * NetRide Premium — every approved vehicle is eligible.
   */
  static async getDriverRidePreferences(req: AuthRequest, res: Response) {
    const { id } = req.params;
    try {
      const { getEligibleRideTypes, rideTypeLabel } = await import('../../services/vehicleEligibility.service');

      const veh = await pool.query(
        `SELECT dv.service_class
         FROM driver_vehicles dv
         WHERE dv.driver_id = $1
         ORDER BY (dv.vehicle_status = 'APPROVED') DESC NULLS LAST
         LIMIT 1`,
        [id]
      );
      const vehicleClass = (veh.rows[0]?.service_class as any) || 'CORE';
      const eligible = getEligibleRideTypes(vehicleClass);

      res.json({
        vehicleClass,
        vehicleClassLabel: rideTypeLabel(vehicleClass as any),
        eligibleRideTypes: eligible,
        eligibleLabels: eligible.reduce((acc: Record<string, string>, rt) => {
          acc[rt] = rideTypeLabel(rt as any);
          return acc;
        }, {}),
      });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Driver ride eligibility error: ${error.message}`);
      res.status(500).json({ error: 'Failed to load driver ride eligibility.' });
    }
  }

  static async getUserById(req: AuthRequest, res: Response) {
    const { id } = req.params;
    try {
      // Use raw SQL to include drivers.phone_number (not in Prisma Driver model).
      // d.* overwrites u.* for columns with the same name (e.g. phone_number),
      // so the result contains the driver-specific phone when available.
      const userRes = await pool.query(
        `SELECT u.*, d.*
         FROM users u
         LEFT JOIN drivers d ON u.id = d.user_id
         WHERE u.id = $1`,
        [id]
      );
      if (!userRes.rowCount) {
        return res.status(404).json({ error: 'User record not found.' });
      }
      const row = userRes.rows[0];

      // Reconstruct user (top-level) fields.
      const user: Record<string, any> = {
        id: row.id,
        email: row.email,
        phone_number: row.phone_number, // driver-specific, or NULL
        full_name: row.full_name,
        profile_image_url: row.profile_image_url,
        date_of_birth: row.date_of_birth,
        role: row.role,
        verification_status: row.verification_status,
        is_verified: row.is_verified,
        rejection_reason: row.rejection_reason,
        verification_feedback_seen: row.verification_feedback_seen,
        onboarding_step: row.onboarding_step,
        phone_verified: row.phone_verified,
        headshot_uploaded: row.headshot_uploaded,
        has_password: row.has_password,
        rating: row.rating,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };

      // Riders have no driver record (d.user_id is NULL)
      if (row.user_id === null) {
        user.driver_profile = null;
        res.json(user);
        return;
      }

      // Build driver_profile
      const driverProfile: Record<string, any> = {
        user_id: row.user_id,
        license_number: row.license_number,
        license_expiry_date: row.license_expiry_date,
        license_photo_url: row.license_photo_url,
        license_photo_back_url: row.license_photo_back_url,
        insurance_photo_url: row.insurance_photo_url,
        registration_photo_url: row.registration_photo_url,
        background_check_status: row.background_check_status,
        is_active: row.is_active,
        active_class: row.active_class,
        is_dangerous: row.is_dangerous,
        is_flagged: row.is_flagged,
        rating: row.rating,
        total_rides: row.total_rides,
        rejection_reason: row.rejection_reason,
        verification_feedback_seen: row.verification_feedback_seen,
        phone_number: row.phone_number, // <-- driver-specific phone
        phone_verified: row.phone_verified,
        has_action_required: row.has_action_required,
        last_action_required_at: row.last_action_required_at,
        fleet_id: row.fleet_id ?? null,
        fleet: null,
      };

      // Fleet partner assignment (optional) — drives the platform-pool split
      // for future rides (fleet share comes out of the 40% platform pool,
      // driver share stays 60%).
      if (row.fleet_id) {
        const fleetRes = await pool.query(
          `SELECT id, name, platform_share_percent, is_active
           FROM fleet_partners WHERE id = $1`,
          [row.fleet_id]
        );
        driverProfile.fleet = fleetRes.rows[0] ?? null;
      }

      // Fetch vehicles with submission info — ordered by status (APPROVED first),
      // then by approval timestamp, then by submission timestamp.
      const vehiclesRes = await pool.query(
        `SELECT dv.*, v.make AS catalog_make, v.model AS catalog_model,
                v.year AS catalog_year, v.category, v.service_class
         FROM driver_vehicles dv
         LEFT JOIN vehicles v ON dv.vehicle_id = v.id
         WHERE dv.driver_id = $1
         ORDER BY
           CASE
             WHEN dv.vehicle_status = 'APPROVED' OR dv.vehicle_status IS NULL THEN 0
             ELSE 1
           END,
           dv.approved_at DESC NULLS LAST,
           dv.submitted_at DESC NULLS LAST,
           dv.id DESC`,
        [id]
      );
      driverProfile.vehicles = vehiclesRes.rows;

      // Expose the active vehicle explicitly (for frontend to use directly)
      const activeVeh = vehiclesRes.rows.find(
        (r: any) => r.vehicle_status === 'APPROVED' || r.vehicle_status === null
      );
      driverProfile.active_vehicle = activeVeh || null;

      // Expose the latest finalized vehicle submission (for admin review display)
      const latestFinalized = await pool.query(
        `SELECT s.*, u.full_name AS reviewed_by_admin_name
         FROM driver_vehicle_submissions s
         LEFT JOIN users u ON u.id = s.reviewed_by_admin_id
         WHERE s.driver_id = $1
           AND s.status IN ('APPROVED', 'REJECTED')
         ORDER BY s.reviewed_at DESC NULLS LAST, s.submitted_at DESC
         LIMIT 1`,
        [id]
      );
      driverProfile.latest_finalized_vehicle_submission = latestFinalized.rows[0] || null;

      user.driver_profile = driverProfile;

      // Normalize phone: if driver-specific phone is set, prefer it at user level too.
      if (driverProfile.phone_number) {
        user.phone_number = driverProfile.phone_number;
      }

      // Add action required flag
      const actionRes = await pool.query(
        `SELECT COUNT(*)::int AS c FROM driver_document_requirements
         WHERE driver_id = $1 AND status = 'resubmission_required'`,
        [id]
      );
      user.has_action_required = (actionRes.rows[0]?.c ?? 0) > 0;

      // Attach pending vehicle submissions
      const pendingVehRes = await pool.query(
        `SELECT * FROM driver_vehicle_submissions
         WHERE driver_id = $1 AND status = 'PENDING_REVIEW'
         ORDER BY submitted_at DESC`,
        [id]
      );
      user.pending_vehicle_submissions = pendingVehRes.rows;

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
      // Lock the DOB if it's set (identity verification includes DOB review).
      const existing = await pool.query(
        `SELECT date_of_birth FROM users WHERE id = $1`,
        [id]
      );
      if (existing.rows[0]?.date_of_birth) {
        await pool.query(
          `UPDATE users SET dob_locked = true WHERE id = $1`,
          [id]
        );
      }

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

  static async blockUser(req: AuthRequest, res: Response) {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.user!.id;

    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'A block reason is required.' });
    }

    try {
      const user = await (prisma.user as any).update({
        where: { id },
        data: {
          verification_status: VerificationStatus.BLOCKED,
          is_verified: false,
          blocked_reason: reason,
          verification_feedback_seen: false,
        },
      });

      const hasDriverProfile = await prisma.driver.findUnique({ where: { user_id: id } });
      if (hasDriverProfile) {
        await (prisma.driver as any).update({
          where: { user_id: id },
          data: { is_active: false },
        });
      }

      await prisma.auditLog.create({
        data: {
          admin_id: adminId,
          target_id: id,
          action: 'BLOCK',
          details: `User ${user.email} blocked. Reason: ${reason}`,
        },
      });

      res.json({ message: 'User blocked', user });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Block user error: ${error.message}`);
      res.status(500).json({ error: 'Failed to block user.' });
    }
  }

  static async unblockUser(req: AuthRequest, res: Response) {
    const { id } = req.params;
    const adminId = req.user!.id;
    try {
      const user = await (prisma.user as any).update({
        where: { id },
        data: {
          verification_status: VerificationStatus.VERIFIED,
          is_verified: true,
          blocked_reason: null,
          verification_feedback_seen: false,
        },
      });

      const hasDriverProfile = await prisma.driver.findUnique({ where: { user_id: id } });
      if (hasDriverProfile) {
        await (prisma.driver as any).update({
          where: { user_id: id },
          data: { is_active: true, background_check_status: 'APPROVED' },
        });
      }

      await prisma.auditLog.create({
        data: {
          admin_id: adminId,
          target_id: id,
          action: 'UNBLOCK',
          details: `User ${user.email} unblocked.`,
        },
      });

      res.json({ message: 'User unblocked', user });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Unblock user error: ${error.message}`);
      res.status(500).json({ error: 'Failed to unblock user.' });
    }
  }

  static async getFlaggedRatings(req: AuthRequest, res: Response) {
    try {
      const { page = 1, limit = 20 } = req.query;
      const skip = (Number(page) - 1) * Number(limit);

      const ratingsRes = await pool.query(
        `SELECT r.*,
                ride.pickup_address, ride.destination_address, ride.completed_at,
                rider.full_name AS rider_name, rider.email AS rider_email,
                driver.full_name AS driver_name, driver.email AS driver_email
         FROM ratings r
         JOIN rides ride ON ride.id = r.ride_id
         JOIN users rider ON rider.id = r.rater_id
         JOIN users driver ON driver.id = r.target_id
         WHERE r.flagged_for_review = TRUE
         ORDER BY r.created_at DESC
         LIMIT $1 OFFSET $2`,
        [Number(limit), skip]
      );

      const totalRes = await pool.query(
        `SELECT COUNT(*)::int AS c FROM ratings WHERE flagged_for_review = TRUE`
      );

      res.json({
        ratings: ratingsRes.rows,
        total: totalRes.rows[0]?.c ?? 0,
        page: Number(page),
        totalPages: Math.ceil((totalRes.rows[0]?.c ?? 0) / Number(limit)),
      });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Get flagged ratings error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve flagged ratings.' });
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

      // Server-computed financial summary for the page being viewed. Only
      // the backend may decide these numbers — they come from the
      // settlement ledger, never from the client. Live/active rides have
      // no settlement yet, so no summary is attached.
      let summary: any = undefined;
      if (status === 'COMPLETED' && rides.length > 0) {
        summary = await FinancialLedgerService.summarizeRides(
          rides.map((r: any) => r.id)
        );
      }

      res.json(AdminController.toJSON({
        rides,
        total,
        page: Number(page),
        totalPages: Math.ceil(total / Number(limit)),
        ...(summary ? { summary } : {}),
      }));
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

      res.json(AdminController.toJSON(ride));
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

  /**
   * Planned + actually-driven routes for a ride, for admin map rendering.
   *
   * planned: per-leg polylines from ride_routes (the rider-generated
   *   Google/OSRM route stored at request time), with a fallback to the
   *   destination-leg mirror in rides.route_metadata.
   * actual:  the GPS samples captured during the trip (Redis trajectory
   *   buffer, snapshotted into rides.trajectory at completion). Marked
   *   available only when ≥ 2 valid points exist — a ride with no GPS
   *   samples reports actualRoute.available = false so the frontend never
   *   labels the planned route as the driven one.
   *
   * Coordinates are returned as [lat, lng] pairs; GeoJSON [lng, lat]
   * storage is converted here.
   */
  static async getRideRoutes(req: AuthRequest, res: Response) {
    const { id } = req.params;
    try {
      const rideRes = await pool.query(
        `SELECT id, trajectory, route_metadata FROM rides WHERE id = $1`,
        [id]
      );
      const ride = rideRes.rows[0];
      if (!ride) return res.status(404).json({ error: 'Ride not found.' });

      const toLatLng = (raw: any): Array<[number, number]> => {
        if (!Array.isArray(raw)) return [];
        return raw
          .filter(
            (c: any) =>
              Array.isArray(c) &&
              c.length >= 2 &&
              isFinite(Number(c[0])) &&
              isFinite(Number(c[1])) &&
              Number(c[1]) >= -90 && Number(c[1]) <= 90 &&
              Number(c[0]) >= -180 && Number(c[0]) <= 180,
          )
          .map((c: any) => [Number(c[1]), Number(c[0])]);
      };

      const plannedLegs: any[] = [];
      const legsRes = await pool.query(
        `SELECT leg, distance_meters, duration_seconds, eta_seconds, polyline, engine
         FROM ride_routes WHERE ride_id = $1 ORDER BY created_at ASC`,
        [id]
      );
      for (const row of legsRes.rows) {
        let coordinates: Array<[number, number]> = [];
        try {
          const raw = Array.isArray(row.polyline)
            ? row.polyline
            : JSON.parse(row.polyline ?? '[]');
          coordinates = toLatLng(raw);
        } catch {
          coordinates = [];
        }
        if (coordinates.length >= 2) {
          plannedLegs.push({
            leg: row.leg,
            polyline: coordinates,
            distanceMeters: Number(row.distance_meters) || 0,
            durationSeconds: Number(row.duration_seconds) || 0,
            etaSeconds: row.eta_seconds != null ? Number(row.eta_seconds) : null,
            engine: row.engine ?? null,
          });
        }
      }

      if (plannedLegs.length === 0) {
        try {
          const meta =
            typeof ride.route_metadata === 'string'
              ? JSON.parse(ride.route_metadata)
              : ride.route_metadata;
          const dest = meta?.destination;
          if (dest?.geometry?.coordinates?.length >= 2) {
            plannedLegs.push({
              leg: 'destination',
              polyline: toLatLng(dest.geometry.coordinates),
              distanceMeters: Number(dest.distance ?? 0),
              durationSeconds: Number(dest.duration ?? 0),
              etaSeconds: null,
              engine: dest.engine ?? null,
            });
          }
        } catch {
          // malformed metadata — planned stays empty
        }
      }

      let actualPoints: Array<[number, number]> = [];
      try {
        const rawTrajectory =
          typeof ride.trajectory === 'string'
            ? JSON.parse(ride.trajectory)
            : ride.trajectory;
        if (Array.isArray(rawTrajectory)) {
          actualPoints = rawTrajectory
            .filter(
              (p: any) =>
                p &&
                isFinite(Number(p.lat)) &&
                isFinite(Number(p.lng)) &&
                Number(p.lat) >= -90 && Number(p.lat) <= 90 &&
                Number(p.lng) >= -180 && Number(p.lng) <= 180,
            )
            .map((p: any) => [Number(p.lat), Number(p.lng)]);
        }
      } catch {
        actualPoints = [];
      }

      res.json({
        ride_id: id,
        planned: {
          available: plannedLegs.length > 0,
          legs: plannedLegs,
        },
        actual: {
          available: actualPoints.length >= 2,
          polyline: actualPoints,
          pointCount: actualPoints.length,
        },
      });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Get ride routes error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve ride routes.' });
    }
  }

  /**
   * Full financial picture for one ride: the settlement ledger row
   * (financial_transactions), the rider wallet movements and the driver
   * earnings rows (payouts RIDE_CREDIT / TIP_CREDIT). Money is returned
   * as numbers (cents). Only the backend decides these amounts.
   */
  static async getRideLedger(req: AuthRequest, res: Response) {
    const { id } = req.params;
    try {
      const [ledgerRes, walletRes, payoutsRes] = await Promise.all([
        pool.query(
          `SELECT * FROM financial_transactions
           WHERE ride_id = $1 AND type = 'RIDE_COMPLETION'`,
          [id],
        ),
        pool.query(
          `SELECT id, amount_cents, type, description, idempotency_key,
                  balance_after_cents, created_at
           FROM wallet_transactions WHERE ride_id = $1 ORDER BY created_at DESC`,
          [id],
        ),
        pool.query(
          `SELECT id, amount_cents, fee_cents, net_cents, status, method,
                  requested_at, processed_at
           FROM payouts WHERE ride_id = $1 ORDER BY requested_at DESC`,
          [id],
        ),
      ]);

      res.json({
        ride_id: id,
        settlement: ledgerRes.rows[0] ?? null,
        wallet_transactions: walletRes.rows.map((r: any) => ({
          ...r,
          amount_cents: Number(r.amount_cents),
          balance_after_cents: Number(r.balance_after_cents),
        })),
        payouts: payoutsRes.rows.map((r: any) => ({
          ...r,
          amount_cents: Number(r.amount_cents),
          fee_cents: Number(r.fee_cents),
          net_cents: Number(r.net_cents),
        })),
      });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Get ride ledger error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve ride ledger.' });
    }
  }

  /**
   * Driver earnings from the settlement ledger — the only source the admin
   * UI may use for driver income. Only SETTLED rows count (a cancelled or
   * unpaid ride contributes $0). Returns lifetime + range totals, a
   * server-bucketed time series (UTC buckets) and paginated completed
   * rides. All money is integer cents.
   */
  static async getDriverEarnings(req: AuthRequest, res: Response) {
    const { id } = req.params;
    const range = String(req.query.range ?? '90d');
    const period = String(req.query.period ?? 'week');
    const page = Math.max(Number(req.query.page ?? 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 10), 1), 50);

    const rangeDays =
      range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : null;
    const bucket =
      period === 'day' ? 'day' : period === 'month' ? 'month' : 'week';

    try {
      const rangeWhere = rangeDays
        ? "AND completed_at >= NOW() - ($2::int * INTERVAL '1 day')"
        : '';
      const rangeArgs = rangeDays ? [id, String(rangeDays)] : [id];
      const seriesSql = `SELECT
             date_trunc($${rangeDays ? '3' : '2'}::text, completed_at) AS bucket,
             COALESCE(SUM(driver_share_cents), 0) AS earnings_cents,
             COALESCE(SUM(tip_cents), 0)          AS tip_cents,
             COUNT(*)                             AS rides
           FROM financial_transactions
           WHERE driver_id = $1 AND status = 'SETTLED' AND type = 'RIDE_COMPLETION'
             ${rangeWhere}
           GROUP BY 1 ORDER BY 1 ASC`;

      const [totalsRes, seriesRes, afterTipsRes, ridesRes, countRes] = await Promise.all([
        pool.query(
          `SELECT
             COALESCE(SUM(driver_share_cents), 0) AS earnings_cents,
             COALESCE(SUM(tip_cents), 0)          AS tip_cents,
             COUNT(*)                             AS rides
           FROM financial_transactions
           WHERE driver_id = $1 AND status = 'SETTLED' AND type = 'RIDE_COMPLETION'`,
          [id],
        ),
        pool.query(seriesSql, rangeDays ? [...rangeArgs, bucket] : rangeArgs),
        pool.query(
          `SELECT COALESCE(SUM(amount_cents), 0) AS cents
           FROM payouts
           WHERE driver_id = $1 AND method = 'TIP_CREDIT'`,
          [id],
        ),
        pool.query(
          `SELECT f.ride_id AS id, f.completed_at, f.fare_cents, f.tip_cents,
                  f.driver_share_cents, f.status,
                  r.pickup_address, r.destination_address,
                  u.full_name AS rider_name
           FROM financial_transactions f
           JOIN rides r ON r.id = f.ride_id
           LEFT JOIN users u ON u.id = f.rider_id
           WHERE f.driver_id = $1 AND f.status = 'SETTLED' AND f.type = 'RIDE_COMPLETION'
           ORDER BY f.completed_at DESC
           LIMIT $2 OFFSET $3`,
          [id, limit, (page - 1) * limit],
        ),
        pool.query(
          `SELECT COUNT(*) AS total
           FROM financial_transactions
           WHERE driver_id = $1 AND status = 'SETTLED' AND type = 'RIDE_COMPLETION'`,
          [id],
        ),
      ]);

      const totals = totalsRes.rows[0];
      res.json({
        driver_id: id,
        currency: 'USD',
        range,
        period: bucket,
        dataSource: 'financial_transactions (SETTLED)',
        lifetime: {
          earningsCents: Number(totals.earnings_cents),
          tipCents: Number(totals.tip_cents),
          rides: Number(totals.rides),
          afterTripTipCents: Number(afterTipsRes.rows[0]?.cents ?? 0),
        },
        series: seriesRes.rows.map((r: any) => ({
          bucket: r.bucket instanceof Date ? r.bucket.toISOString() : r.bucket,
          earningsCents: Number(r.earnings_cents),
          tipCents: Number(r.tip_cents),
          rides: Number(r.rides),
        })),
        rides: {
          total: Number(countRes.rows[0]?.total ?? 0),
          page,
          limit,
          rows: ridesRes.rows.map((r: any) => ({
            ...r,
            fare_cents: Number(r.fare_cents),
            tip_cents: Number(r.tip_cents),
            driver_share_cents: Number(r.driver_share_cents),
          })),
        },
      });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Get driver earnings error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve driver earnings.' });
    }
  }

  /**
   * Ledger-driven revenue analytics: platform/driver/gross totals plus a
   * server-bucketed time series and per-ride averages. SETTLED settlements
   * only — cancelled, unpaid or still-pending rides contribute $0 (the
   * backend decides, never the client).
   *
   * range:  7d | 30d | 90d | all   (completed_at >= NOW() - range)
   * bucket: day | week | month     (server-side date_trunc, UTC buckets —
   *                                 the documented analytics convention;
   *                                 the frontend formats for display)
   * region: optional region code — filters by pickup-point geofence
   *         (region_contains on the region center/radius).
   */
  static async getRevenueAnalytics(req: AuthRequest, res: Response) {
    const range = String(req.query.range ?? '30d');
    const bucket = String(req.query.bucket ?? 'day');
    const region = String(req.query.region ?? '').trim();

    const rangeDays =
      range === '7d' ? 7 : range === '90d' ? 90 : range === '30d' ? 30 : null;
    const bucketCol =
      bucket === 'week' ? 'week' : bucket === 'month' ? 'month' : 'day';

    try {
      const joins = ['FROM financial_transactions t JOIN rides r ON r.id = t.ride_id'];
      const where = [
        "t.status = 'SETTLED'",
        "t.type = 'RIDE_COMPLETION'",
      ];
      const params: any[] = [];
      if (rangeDays) {
        params.push(String(rangeDays));
        where.push('t.completed_at >= NOW() - ($1::int * INTERVAL \'1 day\')');
      }
      if (region) {
        params.push(region);
        const n = params.length;
        joins.push(
          `JOIN regions rg ON rg.code = $${n} AND rg.is_active = TRUE`,
        );
        where.push(`region_contains(r.pickup_lat, r.pickup_lng, rg.center_lat, rg.center_lng, rg.radius_km)`);
      }

      const whereSql = `WHERE ${where.join(' AND ')}`;
      const paramMarkers = params.map((_, i) => `$${i + 1}`);

      const [totalsRes, seriesRes] = await Promise.all([
        pool.query(
          `SELECT
             COUNT(*)                                    AS rides,
             COALESCE(SUM(t.gross_amount_cents), 0)      AS gross_cents,
             COALESCE(SUM(t.platform_share_cents), 0)    AS platform_cents,
             COALESCE(SUM(t.driver_share_cents), 0)      AS driver_cents,
             COALESCE(SUM(t.tip_cents), 0)               AS tip_cents,
             COALESCE(SUM(t.promotion_cents), 0)         AS promotion_cents,
             COALESCE(SUM(t.credits_cents), 0)           AS credits_cents
           ${joins.join(' ')}
           ${whereSql}`,
          params,
        ),
        pool.query(
          `SELECT
             date_trunc('${bucketCol}', t.completed_at) AS bucket,
             COUNT(*)                                   AS rides,
             COALESCE(SUM(t.gross_amount_cents), 0)     AS gross_cents,
             COALESCE(SUM(t.platform_share_cents), 0)   AS platform_cents,
             COALESCE(SUM(t.driver_share_cents), 0)     AS driver_cents,
             COALESCE(SUM(t.tip_cents), 0)              AS tip_cents
           ${joins.join(' ')}
           ${whereSql}
           GROUP BY 1 ORDER BY 1 ASC`,
          params,
        ),
      ]);

      const totals = totalsRes.rows[0];
      const rideCount = Number(totals.rides);
      res.json({
        range,
        bucket: bucketCol,
        region: region || null,
        timezone: 'UTC (buckets are UTC; display formatting is client-side)',
        dataSource: 'financial_transactions (SETTLED)',
        totals: {
          rides: rideCount,
          grossCents: Number(totals.gross_cents),
          platformCents: Number(totals.platform_cents),
          driverCents: Number(totals.driver_cents),
          tipCents: Number(totals.tip_cents),
          promotionCents: Number(totals.promotion_cents),
          creditsCents: Number(totals.credits_cents),
          avgFarePerRideCents: rideCount > 0 ? Math.round(Number(totals.gross_cents) / rideCount) : 0,
          avgPlatformPerRideCents: rideCount > 0 ? Math.round(Number(totals.platform_cents) / rideCount) : 0,
        },
        series: seriesRes.rows.map((r: any) => ({
          bucket: r.bucket instanceof Date ? r.bucket.toISOString() : r.bucket,
          rides: Number(r.rides),
          grossCents: Number(r.gross_cents),
          platformCents: Number(r.platform_cents),
          driverCents: Number(r.driver_cents),
          tipCents: Number(r.tip_cents),
        })),
      });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Get revenue analytics error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve revenue analytics.' });
    }
  }

  /** List active regions (used for the analytics region filter). */
  static async listRegions(req: AuthRequest, res: Response) {
    try {
      const res0 = await pool.query(
        `SELECT code, name, country_code, center_lat, center_lng, radius_km,
                is_active, created_at
         FROM regions ORDER BY name ASC`,
      );
      res.json({ regions: res0.rows });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ List regions error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve regions.' });
    }
  }

  /** Create / update a region (admin-only). Validated server-side. */
  static async upsertRegion(req: AuthRequest, res: Response) {
    const { code, name, country_code, center_lat, center_lng, radius_km, is_active } = req.body ?? {};
    try {
      const regionCode = String(code ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
      if (!regionCode || !String(name ?? '').trim()) {
        return res.status(400).json({ error: 'code and name are required.' });
      }
      const lat = Number(center_lat);
      const lng = Number(center_lng);
      const radius = Number(radius_km ?? 25);
      if (!isFinite(lat) || lat < -90 || lat > 90) {
        return res.status(400).json({ error: 'center_lat must be between -90 and 90.' });
      }
      if (!isFinite(lng) || lng < -180 || lng > 180) {
        return res.status(400).json({ error: 'center_lng must be between -180 and 180.' });
      }
      if (!isFinite(radius) || radius <= 0 || radius > 500) {
        return res.status(400).json({ error: 'radius_km must be between 0 and 500.' });
      }

      await pool.query(
        `INSERT INTO regions (code, name, country_code, center_lat, center_lng, radius_km, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name,
           country_code = EXCLUDED.country_code,
           center_lat = EXCLUDED.center_lat,
           center_lng = EXCLUDED.center_lng,
           radius_km = EXCLUDED.radius_km,
           is_active = EXCLUDED.is_active,
           updated_at = NOW()`,
        [regionCode, String(name).trim(), String(country_code ?? 'US').toUpperCase(), lat, lng, radius, is_active !== false],
      );

      const adminId = req.user!.id;
      await AuditEventsService.record({
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'REGION_UPSERT',
        entityType: 'REGION',
        entityId: regionCode,
        details: { radiusKm: radius, lat, lng, countryCode: String(country_code ?? 'US').toUpperCase() },
      });

      const res1 = await pool.query(`SELECT * FROM regions WHERE code = $1`, [regionCode]);
      res.json({ region: res1.rows[0] });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Upsert region error: ${error.message}`);
      res.status(500).json({ error: 'Failed to save region.' });
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

  static async updateLicense(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const adminId = req.user!.id;
      const { license_number, license_expiry_date } = req.body;

      if (!license_number && !license_expiry_date) {
        return res.status(400).json({ error: 'Provide at least one field to update (license_number or license_expiry_date).' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const sets: string[] = [];
        const params: any[] = [];
        let idx = 1;

        if (license_number !== undefined) {
          sets.push(`license_number = $${idx++}`);
          params.push(license_number);
        }
        if (license_expiry_date !== undefined) {
          sets.push(`license_expiry_date = $${idx++}`);
          params.push(license_expiry_date);
        }

        params.push(id);
        await client.query(
          `UPDATE drivers SET ${sets.join(', ')} WHERE user_id = $${idx}`,
          params
        );

        await client.query('COMMIT');

        await prisma.auditLog.create({
          data: {
            admin_id: adminId,
            target_id: id,
            action: 'LICENSE_UPDATED',
            details: `License info updated by admin. Fields: ${sets.join(', ')}.`,
          },
        });

        res.json({ success: true });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Update license error: ${error.message}`);
      res.status(500).json({ error: 'Failed to update license information.' });
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
        await client.query(
          `UPDATE users SET date_of_birth = $1, dob_locked = true WHERE id = $2`,
          [changes.date_of_birth, driverId]
        );
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

      // Mark the request APPROVED + restore the driver's previous state.
      // Using prev_is_active / prev_bg_status from the saved snapshot so that
      // approving a non-background field (e.g. profile picture) does NOT show
      // the green "Background check complete" card — only the separate
      // "Approve User" action (verifyUser) sets background_check_status = 'APPROVED'.
      await client.query(
        `UPDATE profile_change_requests SET status = 'APPROVED', reviewed_at = NOW(), reviewed_by_admin_id = $1 WHERE id = $2`,
        [adminId, id]
      );
      await client.query(
        `UPDATE drivers SET is_active = $1, background_check_status = $2, verification_feedback_seen = false WHERE user_id = $3`,
        [row.prev_is_active ?? false, row.prev_bg_status ?? 'PENDING', driverId]
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
  // Document resubmission requirements (024)
  // ============================================================

  static async requestDocumentResubmission(req: AuthRequest, res: Response) {
    const { id: driverId } = req.params;
    const { documentType, reason } = req.body;
    const adminId = req.user!.id;

    if (!documentType) return res.status(400).json({ error: 'Document type is required.' });
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'Reason for resubmission is required.' });

    const validTypes = ['license_photo_url', 'license_photo_back_url', 'insurance_photo_url',
      'registration_photo_url', 'inspection_photo_url', 'id_photo_front_url', 'id_photo_back_url'];
    if (!validTypes.includes(documentType)) {
      return res.status(400).json({ error: `Invalid document type. Must be one of: ${validTypes.join(', ')}` });
    }

    try {
      // Get the current document URL for this type
      let currentUrl: string | null = null;
      if (['license_photo_url', 'license_photo_back_url', 'insurance_photo_url', 'registration_photo_url'].includes(documentType)) {
        const doc = await pool.query(`SELECT ${documentType} FROM drivers WHERE user_id = $1`, [driverId]);
        currentUrl = doc.rows[0]?.[documentType] ?? null;
      } else if (documentType === 'inspection_photo_url') {
        const doc = await pool.query(`SELECT inspection_photo_url FROM driver_vehicles WHERE driver_id = $1 LIMIT 1`, [driverId]);
        currentUrl = doc.rows[0]?.inspection_photo_url ?? null;
      } else if (['id_photo_front_url', 'id_photo_back_url'].includes(documentType)) {
        const doc = await pool.query(`SELECT ${documentType} FROM users WHERE id = $1`, [driverId]);
        currentUrl = doc.rows[0]?.[documentType] ?? null;
      }

      const result = await pool.query(
        `INSERT INTO driver_document_requirements
         (driver_id, document_type, current_document_url, requested_by_admin_id, request_reason)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [driverId, documentType, currentUrl, adminId, reason]
      );

      // Mark driver as having action required
      await pool.query(
        `UPDATE drivers SET has_action_required = TRUE, last_action_required_at = NOW() WHERE user_id = $1`,
        [driverId]
      );

      await prisma.auditLog.create({
        data: {
          admin_id: adminId,
          target_id: driverId,
          action: 'DOCUMENT_RESUBMISSION_REQUESTED',
          details: `Admin requested resubmission of ${documentType}. Reason: ${reason}`,
        },
      });

      // Fire-and-forget email
      try {
        const userInfo = await pool.query(`SELECT email, full_name FROM users WHERE id = $1`, [driverId]);
        if (userInfo.rows[0]?.email) {
          await EmailService.sendDocumentResubmissionRequestedEmail(
            { email: userInfo.rows[0].email, full_name: userInfo.rows[0].full_name },
            { document_type: documentType, reason }
          );
        }
      } catch (e: any) {
        console.warn('[ADMIN] ⚠️ Resubmission email failed:', e.message);
      }

      // Notify the driver via socket so the Action Required card appears in real time
      try {
        io.to(`driver:${driverId}`).emit('documentRequirementsChanged', {
          has_action_required: true,
        });
      } catch (e: any) {
        console.warn('[ADMIN] ⚠️ Socket notification failed:', e.message);
      }

      res.json({ success: true, requirement: result.rows[0] });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Request document resubmission error: ${error.message}`);
      res.status(500).json({ error: 'Failed to request document resubmission.' });
    }
  }

  static async getDriverDocumentRequirements(req: AuthRequest, res: Response) {
    const { id: driverId } = req.params;
    try {
      const result = await pool.query(
        `SELECT dr.*, a.full_name AS requested_by_admin_name,
                r.full_name AS reviewed_by_admin_name
         FROM driver_document_requirements dr
         LEFT JOIN users a ON a.id = dr.requested_by_admin_id
         LEFT JOIN users r ON r.id = dr.reviewed_by_admin_id
         WHERE dr.driver_id = $1
         ORDER BY dr.requested_at DESC`,
        [driverId]
      );
      res.json({ requirements: result.rows });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Get document requirements error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve document requirements.' });
    }
  }

  static async reviewDocumentRequirement(req: AuthRequest, res: Response) {
    const { id: requirementId } = req.params;
    const { decision } = req.body;
    const adminId = req.user!.id;

    if (!decision || !['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'Valid decision (approved or rejected) is required.' });
    }

    try {
      const reqRow = await pool.query(
        `SELECT dr.* FROM driver_document_requirements dr WHERE dr.id = $1 FOR UPDATE`,
        [requirementId]
      );

      if (!reqRow.rowCount) return res.status(404).json({ error: 'Document requirement not found.' });
      if (reqRow.rows[0].status !== 'submitted') {
        return res.status(400).json({ error: 'Document requirement must be in submitted status to review.' });
      }

      const driverId = reqRow.rows[0].driver_id;
      const documentType = reqRow.rows[0].document_type;

      const updated = await pool.query(
        `UPDATE driver_document_requirements
         SET status = 'reviewed', reviewed_at = NOW(), reviewed_by_admin_id = $1, review_decision = $2, updated_at = NOW()
         WHERE id = $3 RETURNING *`,
        [adminId, decision, requirementId]
      );

      // If approved, update the actual document URL
      if (decision === 'approved') {
        const newUrl = reqRow.rows[0].new_document_url;
        if (newUrl) {
          if (['license_photo_url', 'license_photo_back_url', 'insurance_photo_url', 'registration_photo_url'].includes(documentType)) {
            await pool.query(
              `UPDATE drivers SET ${documentType} = $1, verification_feedback_seen = FALSE WHERE user_id = $2`,
              [newUrl, driverId]
            );
          } else if (documentType === 'inspection_photo_url') {
            await pool.query(
              `UPDATE driver_vehicles SET inspection_photo_url = $1 WHERE driver_id = $2`,
              [newUrl, driverId]
            );
          } else if (['id_photo_front_url', 'id_photo_back_url'].includes(documentType)) {
            await pool.query(
              `UPDATE users SET ${documentType} = $1 WHERE id = $2`,
              [newUrl, driverId]
            );
          }
        }
      }

      // Check if there are any remaining pending requirements; if not, clear action_required flag
      const remaining = await pool.query(
        `SELECT COUNT(*)::int AS c FROM driver_document_requirements
         WHERE driver_id = $1 AND status IN ('resubmission_required', 'submitted')`,
        [driverId]
      );
      if (remaining.rows[0].c === 0) {
        await pool.query(
          `UPDATE drivers SET has_action_required = FALSE WHERE user_id = $1`,
          [driverId]
        );
      }

      await prisma.auditLog.create({
        data: {
          admin_id: adminId,
          target_id: driverId,
          action: `DOCUMENT_RESUBMISSION_${decision.toUpperCase()}`,
          details: `Document ${documentType} resubmission ${decision}.`,
        },
      });

      // Send driver review notification email (fire-and-forget)
      try {
        const driverInfo = await pool.query(
          `SELECT u.email, u.full_name FROM users u WHERE u.id = $1`,
          [driverId]
        );
        const driver = driverInfo.rows[0];
        if (driver) {
          EmailService.sendDocumentResubmissionReviewedEmail(
            { email: driver.email, full_name: driver.full_name },
            { document_type: documentType, decision }
          );
        }
      } catch (emailErr) {
        console.error('❌ [ADMIN] Document review email error:', (emailErr as Error).message);
      }

      // Socket notification to driver so the app re-fetches requirements
      try {
        io.to(`driver:${driverId}`).emit('documentRequirementsChanged', {});
      } catch (socketErr) {
        console.error('❌ [ADMIN] Document review socket error:', (socketErr as Error).message);
      }

      res.json({ success: true, requirement: updated.rows[0] });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Review document requirement error: ${error.message}`);
      res.status(500).json({ error: 'Failed to review document requirement.' });
    }
  }

  // ============================================================
  // Vehicle submission review (025)
  // ============================================================

  static async listVehicleSubmissions(req: AuthRequest, res: Response) {
    try {
      const { status, limit = '50', offset = '0' } = req.query;
      const lim = Math.min(parseInt(String(limit), 10) || 50, 200);
      const off = Math.max(parseInt(String(offset), 10) || 0, 0);
      const where: string[] = [];
      const vals: any[] = [];
      let i = 1;
      if (status) { where.push(`s.status = $${i++}`); vals.push(status); }
      const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      vals.push(lim, off);
      const res0 = await pool.query(
        `SELECT s.*, u.full_name, u.email
         FROM driver_vehicle_submissions s
         JOIN users u ON u.id = s.driver_id
         ${whereClause}
         ORDER BY s.submitted_at DESC
         LIMIT $${i++} OFFSET $${i++}`,
        vals
      );
      const totalRes = await pool.query(
        `SELECT COUNT(*)::int AS c FROM driver_vehicle_submissions ${whereClause}`,
        vals.slice(0, vals.length - 2)
      );
      res.json({ submissions: res0.rows, total: totalRes.rows[0]?.c ?? 0 });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ List vehicle submissions error: ${error.message}`);
      res.status(500).json({ error: 'Failed to list vehicle submissions.' });
    }
  }

  static async getVehicleSubmission(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const res0 = await pool.query(
        `SELECT s.*, u.full_name, u.email
         FROM driver_vehicle_submissions s
         JOIN users u ON u.id = s.driver_id
         WHERE s.id = $1`,
        [id]
      );
      if (!res0.rowCount) {
        return res.status(404).json({ error: 'Vehicle submission not found.' });
      }
      res.json(res0.rows[0]);
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Get vehicle submission error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve vehicle submission.' });
    }
  }

  static async approveVehicleSubmission(req: AuthRequest, res: Response) {
    const { id } = req.params;
    const adminId = req.user!.id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the submission row
      const sub = await client.query(
        `SELECT * FROM driver_vehicle_submissions WHERE id = $1 AND status = 'PENDING_REVIEW' FOR UPDATE`,
        [id]
      );
      if (!sub.rowCount) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({ error: 'Pending vehicle submission not found.' });
      }
      const row = sub.rows[0];
      const driverId = row.driver_id;

      // 1. Mark the previous active/approved vehicle as INACTIVE
      await client.query(
        `UPDATE driver_vehicles
         SET vehicle_status = 'INACTIVE', updated_at = NOW()
         WHERE driver_id = $1
           AND (vehicle_status = 'APPROVED' OR vehicle_status IS NULL)`,
        [driverId]
      );

      // 2. Derive the vehicle class from VERIFIED attributes via the
      //    centralized eligibility engine. This is the single place ride
      //    classification happens.
      const { computeVehicleClass } = await import('../../services/vehicleEligibility.service');
      const eligibility = computeVehicleClass({
        isLuxury: row.is_luxury ?? false,
        seats: row.seats ?? undefined,
        exteriorColor: row.color,
        interiorColor: row.interior_color,
      });
      const derivedClass = eligibility.vehicleClass;
      console.log(`[ADMIN] Derived vehicle class ${derivedClass} for submission ${id} (checks: ${eligibility.checks.map(c => `${c.rule}=${c.passed}`).join(', ')})`);

      // 3. Update or create the approved driver_vehicles row
      const existingVeh = await client.query(
        `UPDATE driver_vehicles
         SET vehicle_status = 'APPROVED', make = $2, model = $3, year = $4,
             color = $5, interior_color = $6, seats = $13, is_luxury = $14, service_class = $15,
             license_plate_number = $7,
             license_plate_state = $8, zip_code = $9,
             registration_photo_url = $10, insurance_photo_url = $11,
             inspection_photo_url = $12, approved_at = NOW(), updated_at = NOW()
         WHERE driver_id = $1 AND vehicle_status = 'PENDING_REVIEW'
         RETURNING id`,
        [driverId, row.make, row.model, row.year, row.color,
         row.interior_color, row.license_plate_number,
         row.license_plate_state, row.zip_code,
         row.registration_photo_url, row.insurance_photo_url,
         row.inspection_photo_url,
         row.seats ?? null, row.is_luxury ?? false, derivedClass]
      );

      let vehId = existingVeh.rows[0]?.id;
      if (!vehId) {
        const ins = await client.query(
          `INSERT INTO driver_vehicles
           (driver_id, vehicle_status, make, model, year, color, interior_color,
            seats, is_luxury, service_class,
            license_plate_number, license_plate_state, zip_code,
            registration_photo_url, insurance_photo_url, inspection_photo_url,
            approved_at, submitted_at)
           VALUES ($1, 'APPROVED', $2, $3, $4, $5, $6, $13, $14, $15, $7, $8, $9, $10, $11, $12, NOW(), NOW())
           RETURNING id`,
          [driverId, row.make, row.model, row.year, row.color,
           row.interior_color, row.license_plate_number,
           row.license_plate_state, row.zip_code,
           row.registration_photo_url, row.insurance_photo_url,
           row.inspection_photo_url,
           row.seats ?? null, row.is_luxury ?? false, derivedClass]
        );
        vehId = ins.rows[0].id;
      }

      // 3. Mark the submission as APPROVED
      await client.query(
        `UPDATE driver_vehicle_submissions
         SET status = 'APPROVED', reviewed_at = NOW(), reviewed_by_admin_id = $2
         WHERE id = $1`,
        [id, adminId]
      );

      // 4. Ensure driver is active
      await client.query(
        `UPDATE drivers SET is_active = true, verification_feedback_seen = false WHERE user_id = $1`,
        [driverId]
      );

      await client.query('COMMIT');

      await prisma.auditLog.create({
        data: {
          admin_id: adminId,
          target_id: driverId,
          action: 'VEHICLE_SUBMISSION_APPROVED',
          details: `Vehicle submission ${id} approved. Previous active vehicle marked inactive.`,
        },
      });

      res.json({ success: true, vehicle_id: vehId });
    } catch (error: any) {
      await client.query('ROLLBACK');
      console.error(`[ADMIN] ❌ Approve vehicle submission error: ${error.message}`);
      res.status(500).json({ error: 'Failed to approve vehicle submission.' });
    } finally {
      client.release();
    }
  }

  static async rejectVehicleSubmission(req: AuthRequest, res: Response) {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.user!.id;
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'Rejection reason is required.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const sub = await client.query(
        `SELECT * FROM driver_vehicle_submissions WHERE id = $1 AND status = 'PENDING_REVIEW' FOR UPDATE`,
        [id]
      );
      if (!sub.rowCount) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({ error: 'Pending vehicle submission not found.' });
      }
      const row = sub.rows[0];

      // Remove the pending driver_vehicles row
      await client.query(
        `DELETE FROM driver_vehicles WHERE driver_id = $1 AND vehicle_status = 'PENDING_REVIEW'`,
        [row.driver_id]
      );

      // Also remove the duplicate pending submission row if exists (created alongside driver_vehicles)
      await client.query(
        `DELETE FROM driver_vehicle_submissions
         WHERE driver_id = $1 AND status = 'PENDING_REVIEW' AND id != $2`,
        [row.driver_id, id]
      );

      await client.query(
        `UPDATE driver_vehicle_submissions
         SET status = 'REJECTED', rejection_reason = $2, reviewed_at = NOW(),
             reviewed_by_admin_id = $3
         WHERE id = $1`,
        [id, reason, adminId]
      );

      await client.query('COMMIT');

      await prisma.auditLog.create({
        data: {
          admin_id: adminId,
          target_id: row.driver_id,
          action: 'VEHICLE_SUBMISSION_REJECTED',
          details: `Vehicle submission ${id} rejected: ${reason}`,
        },
      });

      res.json({ success: true });
    } catch (error: any) {
      await client.query('ROLLBACK');
      console.error(`[ADMIN] ❌ Reject vehicle submission error: ${error.message}`);
      res.status(500).json({ error: 'Failed to reject vehicle submission.' });
    } finally {
      client.release();
    }
  }

  static async requestVehicleChanges(req: AuthRequest, res: Response) {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.user!.id;
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'Change request reason is required.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const sub = await client.query(
        `SELECT * FROM driver_vehicle_submissions WHERE id = $1 AND status = 'PENDING_REVIEW' FOR UPDATE`,
        [id]
      );
      if (!sub.rowCount) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({ error: 'Pending vehicle submission not found.' });
      }
      const row = sub.rows[0];
      const driverId = row.driver_id;

      // Update submission status with the admin note
      await client.query(
        `UPDATE driver_vehicle_submissions
         SET status = 'RESUBMISSION_REQUIRED', rejection_reason = $2,
             reviewed_at = NOW(), reviewed_by_admin_id = $3
         WHERE id = $1`,
        [id, reason, adminId]
      );

      // Update the pending driver_vehicles row
      await client.query(
        `UPDATE driver_vehicles
         SET vehicle_status = 'RESUBMISSION_REQUIRED'
         WHERE driver_id = $1 AND vehicle_status = 'PENDING_REVIEW'`,
        [driverId]
      );

      // Mark driver as having vehicle action required
      await client.query(
        `UPDATE drivers
         SET has_vehicle_action_required = TRUE,
             last_vehicle_action_required_at = NOW()
         WHERE user_id = $1`,
        [driverId]
      );

      // Create a resubmission request record
      await client.query(
        `INSERT INTO driver_vehicle_resubmission_requests
         (driver_id, submission_id, requested_by_admin_id, reason, status)
         VALUES ($1, $2, $3, $4, 'resubmission_required')`,
        [driverId, id, adminId, reason]
      );

      await client.query('COMMIT');

      await prisma.auditLog.create({
        data: {
          admin_id: adminId,
          target_id: driverId,
          action: 'VEHICLE_SUBMISSION_CHANGES_REQUESTED',
          details: `Vehicle submission ${id} changes requested: ${reason}`,
        },
      });

      res.json({ success: true });
    } catch (error: any) {
      await client.query('ROLLBACK');
      console.error(`[ADMIN] ❌ Request vehicle changes error: ${error.message}`);
      res.status(500).json({ error: 'Failed to request vehicle changes.' });
    } finally {
      client.release();
    }
  }

  /**
   * Request a full vehicle resubmission for the driver.
   * Creates a resubmission request, marks action required on the driver,
   * and sets the driver_vehicles row to RESUBMISSION_REQUIRED.
   * Unlike requestVehicleChanges (which targets a specific pending submission),
   * this can be used to request a completely new vehicle submission
   * even for previously approved/rejected vehicles.
   */
  static async requestVehicleResubmission(req: AuthRequest, res: Response) {
    const { id: driverId } = req.params;
    const { reason } = req.body;
    const adminId = req.user!.id;
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'Resubmission request reason is required.' });
    }
    if (reason.length > 2000) {
      return res.status(400).json({ error: 'Reason must not exceed 2000 characters.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verify the target is a driver
      const driverCheck = await client.query(
        `SELECT user_id FROM drivers WHERE user_id = $1`,
        [driverId]
      );
      if (!driverCheck.rowCount) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({ error: 'Driver not found.' });
      }

      // Mark any existing driver_vehicles as needing resubmission
      await client.query(
        `UPDATE driver_vehicles
         SET vehicle_status = 'RESUBMISSION_REQUIRED'
         WHERE driver_id = $1 AND vehicle_status = 'APPROVED'`,
        [driverId]
      );

      // Mark driver as having vehicle action required
      await client.query(
        `UPDATE drivers
         SET has_vehicle_action_required = TRUE,
             last_vehicle_action_required_at = NOW()
         WHERE user_id = $1`,
        [driverId]
      );

      // Create a resubmission request
      const ins = await client.query(
        `INSERT INTO driver_vehicle_resubmission_requests
         (driver_id, requested_by_admin_id, reason, status)
         VALUES ($1, $2, $3, 'resubmission_required')
         RETURNING id`,
        [driverId, adminId, reason]
      );

      await client.query('COMMIT');

      await prisma.auditLog.create({
        data: {
          admin_id: adminId,
          target_id: driverId,
          action: 'VEHICLE_RESUBMISSION_REQUESTED',
          details: `Vehicle resubmission requested for driver ${driverId}: ${reason}`,
        },
      });

      // Notify the driver via socket so the Action Required card appears in real time
      try {
        io.to(`driver:${driverId}`).emit('vehicleRequirementsChanged', {
          has_action_required: true,
        });
      } catch (e: any) {
        console.warn('[ADMIN] ⚠️ Socket notification for vehicle failed:', e.message);
      }

      res.json({
        success: true,
        resubmission_request_id: ins.rows[0].id,
      });
    } catch (error: any) {
      await client.query('ROLLBACK');
      console.error(`[ADMIN] ❌ Request vehicle resubmission error: ${error.message}`);
      res.status(500).json({ error: 'Failed to request vehicle resubmission.' });
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
      const totalRes = await pool.query(`SELECT COUNT(*)::int AS c FROM payouts p ${whereClause}`, vals.slice(0, vals.length - 2));
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

  // ==========================================================================
  // Admin image/document management
  // ==========================================================================

  /** Allowed document fields and which table+column they map to. */
  private static readonly DOCUMENT_FIELDS: Record<string, { table: string; column: string }> = {
    profile_image_url:      { table: 'users',   column: 'profile_image_url' },
    license_photo_url:      { table: 'drivers', column: 'license_photo_url' },
    license_photo_back_url: { table: 'drivers', column: 'license_photo_back_url' },
    insurance_photo_url:    { table: 'drivers', column: 'insurance_photo_url' },
    registration_photo_url: { table: 'drivers', column: 'registration_photo_url' },
    id_photo_front_url:     { table: 'users',   column: 'id_photo_front_url' },
    id_photo_back_url:      { table: 'users',   column: 'id_photo_back_url' },
  };

  static async uploadUserDocument(req: AuthRequest, res: Response) {
    const { id } = req.params;
    const { field, image, mimetype } = req.body;

    if (!field || !image || !mimetype) {
      return res.status(400).json({ error: 'Missing required fields: field, image, mimetype' });
    }

    const mapping = AdminController.DOCUMENT_FIELDS[field as string];
    if (!mapping) {
      return res.status(400).json({ error: `Unknown document field: ${field}` });
    }

    try {
      const buffer = Buffer.from(image, 'base64');
      if (buffer.length > 5 * 1024 * 1024) {
        return res.status(413).json({ error: 'File too large. Max 5MB.' });
      }
      const fileType = field.replace(/_url$/, '');
      const adminId = req.user?.id || id;

      const { id: fileId, url } = await StorageService.upload(buffer, {
        userId: id,
        fileType,
        originalName: field,
        mimetype,
      });

      // Update the database with the portable /api/files/:id URL
      await pool.query(
        `UPDATE ${mapping.table} SET ${mapping.column} = $1 WHERE ${mapping.table === 'users' ? 'id' : 'user_id'} = $2`,
        [url, id]
      );

      console.log(`[ADMIN] Uploaded ${field} for user ${id} -> ${url}`);
      res.json({ url });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Upload document error: ${error.message}`);
      res.status(500).json({ error: 'Failed to upload document.' });
    }
  }

  static async deleteUserDocument(req: AuthRequest, res: Response) {
    const { id } = req.params;
    const { field } = req.body;

    if (!field) {
      return res.status(400).json({ error: 'Missing required field: field' });
    }

    const mapping = AdminController.DOCUMENT_FIELDS[field as string];
    if (!mapping) {
      return res.status(400).json({ error: `Unknown document field: ${field}` });
    }

    try {
      await pool.query(
        `UPDATE ${mapping.table} SET ${mapping.column} = NULL WHERE ${mapping.table === 'users' ? 'id' : 'user_id'} = $1`,
        [id]
      );

      console.log(`[ADMIN] Deleted ${field} for user ${id}`);
      res.json({ success: true });
    } catch (error: any) {
      console.error(`[ADMIN] �?O Delete document error: ${error.message}`);
      res.status(500).json({ error: 'Failed to delete document.' });
    }
  }

  // ============================================================
  // Ride reports (042) — post-cancellation / post-ride party reporting

  static async listReports(req: AuthRequest, res: Response) {
    try {
      const { status, reported_role, q, limit, offset } = req.query as any;
      const result = await ReportService.listReports({
        status: typeof status === 'string' ? status : undefined,
        reported_role: typeof reported_role === 'string' ? reported_role : undefined,
        q: typeof q === 'string' ? q : undefined,
        limit: limit ? parseInt(limit, 10) : 25,
        offset: offset ? parseInt(offset, 10) : 0,
      });

      const rows = result.rows.map((row: any) => ({
        ...row,
        reason_label: reportReasonLabel(row.reported_role as PartyRole, row.reason_code),
      }));

      res.json({ total: result.total, rows });
    } catch (error: any) {
      console.error(`[ADMIN] ❌ List reports error: ${error.message}`);
      res.status(500).json({ error: 'Failed to list ride reports.' });
    }
  }

  static async resolveReport(req: AuthRequest, res: Response) {
    try {
      const adminId = req.user?.id;
      if (!adminId) return res.status(401).json({ error: 'Unauthorized' });

      const { status, action, admin_notes } = req.body ?? {};
      if (!['IN_REVIEW', 'RESOLVED', 'DISMISSED'].includes(status)) {
        return res.status(400).json({ error: 'Invalid resolution status.' });
      }
      if (status === 'DISMISSED' && action && action !== 'NO_ACTION') {
        return res.status(400).json({ error: 'A dismissed report cannot carry a penalty action.' });
      }

      const report = await ReportService.resolveReport(req.params.id, adminId, {
        status,
        action: action ?? 'NO_ACTION',
        admin_notes,
      });

      const withLabel = {
        ...(report as any),
        reason_label: reportReasonLabel(report.reported_role, report.reason_code),
      };
      res.json(withLabel);
    } catch (error: any) {
      console.error(`[ADMIN] ❌ Resolve report error: ${error.message}`);
res.status(error?.status ?? 400).json({ error: error?.message || 'Failed to resolve report.' });
    }
  }
}
