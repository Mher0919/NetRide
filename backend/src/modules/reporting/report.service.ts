// backend/src/modules/reporting/report.service.ts
//
// Post-ride party reporting (042). Both ride parties — rider and driver —
// may independently file a report against the other party after a terminal
// ride (CANCELLED or COMPLETED), regardless of who cancelled. Reports are
// party-only, one per (ride, reporter), and reason codes are role-scoped.

import { pool } from '../../config/database';
import { prisma } from '../../services/prisma.service';
import { isReportReasonValid, PartyRole } from './report.reasons';

export interface RideReportRow {
  id: string;
  ride_id: string;
  reporter_id: string;
  reported_user_id: string;
  reported_role: PartyRole;
  reason_code: string;
  reason_text: string | null;
  description: string;
  status: string;
  resolution_action: string | null;
  admin_notes: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
}

export type Eligibility =
  | { ok: true; trip: any; reported_user_id: string; reported_role: PartyRole }
  | { ok: false; code: number; error: string };

function mapReportRow(row: any): RideReportRow {
  return {
    id: row.id,
    ride_id: row.ride_id,
    reporter_id: row.reporter_id,
    reported_user_id: row.reported_user_id,
    reported_role: row.reported_role,
    reason_code: row.reason_code,
    reason_text: row.reason_text ?? null,
    description: row.description,
    status: row.status,
    resolution_action: row.resolution_action ?? null,
    admin_notes: row.admin_notes ?? null,
    resolved_by: row.resolved_by ?? null,
    resolved_at: row.resolved_at ?? null,
    created_at: row.created_at,
  };
}

export class ReportService {
  /**
   * A report may only be filed by one of the two ride parties, against the
   * OTHER party, once the ride has reached a terminal state (CANCELLED or
   * COMPLETED). The reported user is derived from the ride — a reporter can
   * never name their own target, so self-reports are impossible by construction.
   */
  private static async assertEligible(
    rideId: string,
    reporterId: string,
    role: string,
  ): Promise<Eligibility> {
    if (role !== 'RIDER' && role !== 'DRIVER') {
      return { ok: false, code: 403, error: 'Only riders and drivers can file reports.' };
    }

    const res = await pool.query(
      `SELECT id, rider_id, driver_id, status FROM rides WHERE id = $1`,
      [rideId],
    );
    if (res.rows.length === 0) {
      return { ok: false, code: 404, error: 'Trip not found.' };
    }
    const trip = res.rows[0];

    const isRider = trip.rider_id === reporterId;
    const isDriver = trip.driver_id === reporterId;
    if (!isRider && !isDriver) {
      return { ok: false, code: 403, error: 'You are not a party to this trip.' };
    }

    const reported_user_id = isRider ? trip.driver_id : trip.rider_id;
    if (!reported_user_id) {
      return { ok: false, code: 409, error: 'The other party is not on this ride anymore.' };
    }

    if (trip.status !== 'CANCELLED' && trip.status !== 'COMPLETED') {
      return { ok: false, code: 409, error: 'Reports can only be filed after the ride has ended.' };
    }

    return {
      ok: true,
      trip,
      reported_user_id,
      reported_role: (isRider ? 'DRIVER' : 'RIDER') as PartyRole,
    };
  }

  /** Pre-submit state for the report UI: can the caller report this ride? */
  static async getReportStatus(rideId: string, reporterId: string, role: string) {
    const eligible = await this.assertEligible(rideId, reporterId, role);

    const existing = await pool.query(
      `SELECT * FROM ride_reports WHERE ride_id = $1 AND reporter_id = $2`,
      [rideId, reporterId],
    );

    if (!eligible.ok) {
      return {
        canReport: false,
        error: eligible.error,
        alreadyReported: existing.rows.length > 0,
        report: existing.rows.length > 0 ? mapReportRow(existing.rows[0]) : null,
        reasons: [],
        reported_user: null,
      };
    }

    const reported = await pool.query(
      `SELECT id, full_name, email, role FROM users WHERE id = $1`,
      [eligible.reported_user_id],
    );

    return {
      canReport: true,
      error: null,
      alreadyReported: existing.rows.length > 0,
      report: existing.rows.length > 0 ? mapReportRow(existing.rows[0]) : null,
      reasons: undefined, // filled by the controller with the static list
      reported_user: reported.rows[0]
        ? {
            id: reported.rows[0].id,
            full_name: reported.rows[0].full_name,
            email: reported.rows[0].email,
            role: reported.rows[0].role,
          }
        : null,
    };
  }

  /**
   * File a report against the other ride party. Fails with 409 when the
   * caller already filed a report for this ride (one per reporter per ride).
   */
  static async submitReport(
    rideId: string,
    reporterId: string,
    role: string,
    data: { reason_code: string; reason_text?: string; description: string },
  ): Promise<RideReportRow> {
    const eligible = await this.assertEligible(rideId, reporterId, role);
    if (!eligible.ok) {
      const err: any = new Error(eligible.error);
      err.status = eligible.code;
      throw err;
    }

    const reporterRole = (role === 'DRIVER' ? 'DRIVER' : 'RIDER') as PartyRole;
    if (!isReportReasonValid(reporterRole, data.reason_code)) {
      const err: any = new Error('Invalid report reason.');
      err.status = 400;
      throw err;
    }

    const description = (data.description ?? '').trim();
    if (description.length < 10) {
      const err: any = new Error('Please provide a few more details (at least 10 characters).');
      err.status = 400;
      throw err;
    }
    if (description.length > 2000) {
      const err: any = new Error('Please keep the details under 2000 characters.');
      err.status = 400;
      throw err;
    }

    try {
      const res = await pool.query(
        `INSERT INTO ride_reports (
           ride_id, reporter_id, reported_user_id, reported_role,
           reason_code, reason_text, description
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          rideId,
          reporterId,
          eligible.reported_user_id,
          eligible.reported_role,
          data.reason_code,
          (data.reason_text ?? '').trim().slice(0, 300) || null,
          description,
        ],
      );
      return mapReportRow(res.rows[0]);
    } catch (e: any) {
      if (e.code === '23505') {
        const err: any = new Error('You have already filed a report for this ride.');
        err.status = 409;
        throw err;
      }
      throw e;
    }
  }
// ---------------------------------------------------------------------
  // Admin surface
  // ---------------------------------------------------------------------
  static async listReports(filters: {
    status?: string;
    reported_role?: string;
    q?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: string[] = [];
    const params: any[] = [];
    const { status, reported_role, q } = filters;

    if (status) {
      params.push(status);
      where.push(`rr.status = $${params.length}`);
    }
    if (reported_role === 'RIDER' || reported_role === 'DRIVER') {
      params.push(reported_role);
      where.push(`rr.reported_role = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(
        `(rep.full_name ILIKE $${params.length} OR rep.email ILIKE $${params.length} OR rpd.full_name ILIKE $${params.length} OR rpd.email ILIKE $${params.length} OR rr.reason_code ILIKE $${params.length})`,
      );
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
    const offset = Math.max(filters.offset ?? 0, 0);

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM ride_reports rr
         JOIN users rep ON rep.id = rr.reporter_id
         JOIN users rpd ON rpd.id = rr.reported_user_id
         ${whereSql}`,
      params,
    );

    const rowsRes = await pool.query(
      `SELECT rr.*,
              rep.full_name AS reporter_name, rep.email AS reporter_email,
              rep.role AS reporter_role,
              rpd.full_name AS reported_name, rpd.email AS reported_email,
              rpd.is_active AS reported_is_active,
              r.pickup_address, r.destination_address,
              r.status AS ride_status, r.cancelled_at, r.cancelled_by,
              r.cancellation_reason_code
         FROM ride_reports rr
         JOIN users rep ON rep.id = rr.reporter_id
         JOIN users rpd ON rpd.id = rr.reported_user_id
         JOIN rides r ON r.id = rr.ride_id
         ${whereSql}
         ORDER BY rr.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );

    return {
      total: countRes.rows[0]?.total ?? 0,
      rows: rowsRes.rows,
    };
  }

  /**
   * Admin resolution. `action` mirrors the human decision:
   *   NO_ACTION        — report reviewed, no penalty.
   *   WARNING_ISSUED   — warning recorded via audit log.
   *   ACCOUNT_SUSPENDED — deactivates the reported user (is_active=false
   *                      + blocked_reason), surfacing in the existing
   *                      blocked-account handling of both apps.
   */
  static async resolveReport(
    reportId: string,
    adminId: string,
    data: { status: string; action: string; admin_notes?: string },
  ) {
    const status = data.status;
    if (!['IN_REVIEW', 'RESOLVED', 'DISMISSED'].includes(status)) {
      const err: any = new Error('Invalid resolution status.');
      err.status = 400;
      throw err;
    }
    const action = data.action ?? 'NO_ACTION';
    if (!['NO_ACTION', 'WARNING_ISSUED', 'ACCOUNT_SUSPENDED'].includes(action)) {
      const err: any = new Error('Invalid resolution action.');
      err.status = 400;
      throw err;
    }

    const res = await pool.query(
      `SELECT * FROM ride_reports WHERE id = $1`,
      [reportId],
    );
    if (res.rows.length === 0) {
      const err: any = new Error('Report not found.');
      err.status = 404;
      throw err;
    }
    const report = res.rows[0];

    if (action === 'ACCOUNT_SUSPENDED') {
      await pool.query(
        `UPDATE users SET is_active = false, blocked_reason = $1 WHERE id = $2`,
        [
          ((data.admin_notes ?? '').trim() ||
            `Account suspended following a verified ride report (${report.reason_code})`).slice(0, 500),
          report.reported_user_id,
        ],
      );
    }

    const updated = await pool.query(
      `UPDATE ride_reports
          SET status = $1, resolution_action = $2, admin_notes = $3,
              resolved_by = $4, resolved_at = NOW()
        WHERE id = $5
        RETURNING *`,
      [
        status,
        action,
        (data.admin_notes ?? '').trim().slice(0, 1000) || null,
        adminId,
        reportId,
      ],
    );

    await prisma.auditLog.create({
      data: {
        admin_id: adminId,
        target_id: report.reported_user_id,
        action: 'REPORT_RESOLVED',
        details: JSON.stringify({
          reportId,
          rideId: report.ride_id,
          reasonCode: report.reason_code,
          status,
          action,
        }),
      },
    });

    return mapReportRow(updated.rows[0]);
  }
}