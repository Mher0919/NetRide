// backend/src/services/face.service.ts
//
// All DB writes and business logic for face verification. Keeps the
// controller thin and gives us a single place to audit-log every event.

import { pool } from '../config/database';
import { env } from '../config/env';
import { ImageVerifyResult, verifyImage } from './faceMatcher';
import { io } from '../app';
import { EmailService } from './email.service';
import { isTestEmail } from '../utils/testUser';

export type FaceCheckReason =
  | 'flagged'
  | 'enrollment'
  | 'first_time'
  | '12h_expired'
  | 'new_device'
  | 'location_jump'
  | null;

export interface FaceCheckRequired {
  required: boolean;
  reason: FaceCheckReason;
  faceCheckStatus: 'CLEAR' | 'FLAGGED' | 'PENDING_REVIEW';
  lastFaceCheckAt: Date | null;
}

function haversineMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 *
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
  return 2 * R * Math.asin(Math.sqrt(x));
}

export const FaceService = {
  /**
   * Read the driver's persisted face state and decide whether they need
   * to re-verify before going online. The check is intentionally generous
   * — better to ask once too often than to let a flagged driver drive.
   */
  async isCheckRequired(userId: string, opts: {
    deviceId?: string | null;
    onlineLat?: number | null;
    onlineLng?: number | null;
  }): Promise<FaceCheckRequired> {
    const res = await pool.query(
      `SELECT email,
              face_enrollment_url,
              last_face_check_at,
              last_face_check_score,
              last_device_id,
              last_offline_lat,
              last_offline_lng,
              face_check_status
         FROM users WHERE id = $1`,
      [userId],
    );
    const row = res.rows[0];
    if (!row) {
      return {
        required: true,
        reason: 'enrollment',
        faceCheckStatus: 'CLEAR',
        lastFaceCheckAt: null,
      };
    }

    if (row.email && isTestEmail(row.email)) {
      return {
        required: false,
        reason: null,
        faceCheckStatus: row.face_check_status || 'CLEAR',
        lastFaceCheckAt: row.last_face_check_at || null,
      };
    }

    if (row.face_check_status === 'FLAGGED') {
      return {
        required: true,
        reason: 'flagged',
        faceCheckStatus: 'FLAGGED',
        lastFaceCheckAt: row.last_face_check_at || null,
      };
    }

    if (!row.face_enrollment_url) {
      return {
        required: true,
        reason: 'enrollment',
        faceCheckStatus: row.face_check_status || 'CLEAR',
        lastFaceCheckAt: row.last_face_check_at || null,
      };
    }

    if (!row.last_face_check_at) {
      return {
        required: true,
        reason: 'first_time',
        faceCheckStatus: row.face_check_status || 'CLEAR',
        lastFaceCheckAt: null,
      };
    }

    const hours = env.FACE_CHECK_INTERVAL_HOURS;
    const ageMs = Date.now() - new Date(row.last_face_check_at).getTime();
    if (ageMs > hours * 60 * 60 * 1000) {
      return {
        required: true,
        reason: '12h_expired',
        faceCheckStatus: row.face_check_status || 'CLEAR',
        lastFaceCheckAt: row.last_face_check_at,
      };
    }

    if (
      opts.deviceId &&
      row.last_device_id &&
      opts.deviceId !== row.last_device_id
    ) {
      return {
        required: true,
        reason: 'new_device',
        faceCheckStatus: row.face_check_status || 'CLEAR',
        lastFaceCheckAt: row.last_face_check_at,
      };
    }

    if (
      opts.onlineLat != null &&
      opts.onlineLng != null &&
      row.last_offline_lat != null &&
      row.last_offline_lng != null
    ) {
      const miles = haversineMiles(
        { lat: Number(opts.onlineLat), lng: Number(opts.onlineLng) },
        { lat: Number(row.last_offline_lat), lng: Number(row.last_offline_lng) },
      );
      if (miles > env.FACE_LOCATION_JUMP_MILES) {
        return {
          required: true,
          reason: 'location_jump',
          faceCheckStatus: row.face_check_status || 'CLEAR',
          lastFaceCheckAt: row.last_face_check_at,
        };
      }
    }

    return {
      required: false,
      reason: null,
      faceCheckStatus: row.face_check_status || 'CLEAR',
      lastFaceCheckAt: row.last_face_check_at,
    };
  },

  /**
   * Persist the device id and last offline location. Called from the auth
   * flow and from the socket's goOffline handler.
   */
  async recordDeviceAndOfflineLocation(userId: string, opts: {
    deviceId?: string | null;
    offlineLat?: number | null;
    offlineLng?: number | null;
  }): Promise<void> {
    const sets: string[] = [];
    const vals: any[] = [userId];

    if (opts.deviceId) {
      vals.push(opts.deviceId);
      sets.push(`last_device_id = $${vals.length}`);
    }
    if (opts.offlineLat != null && opts.offlineLng != null) {
      vals.push(opts.offlineLat);
      vals.push(opts.offlineLng);
      vals.push(new Date());
      sets.push(`last_offline_lat = $${vals.length - 2}`);
      sets.push(`last_offline_lng = $${vals.length - 1}`);
      sets.push(`last_offline_at = $${vals.length}`);
    }

    if (sets.length === 0) return;
    await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $1`,
      vals,
    );
  },

  /**
   * Run in-process TypeScript face verification against a single selfie.
   * (new single-selfie flow with quality + anti-spoofing + identity match)
   */
  async runImageVerification(args: {
    userId: string;
    imageBuffer: Buffer;
    imageMime: string;
    imageFilename: string;
    referenceDescriptor?: number[] | null;
    isEnrollment?: boolean;
    deviceId?: string | null;
    lat?: number | null;
    lng?: number | null;
  }): Promise<ImageVerifyResult & { flagged: boolean; eventId: string | null }> {
    let result: ImageVerifyResult;
    try {
      result = await verifyImage({
        selfieBuffer: args.imageBuffer,
        referenceDescriptor: args.referenceDescriptor,
      });
    } catch (err: any) {
      console.error('[FACE] verification error (image):', err.message);
      result = {
        match: false,
        score: 0,
        reason: 'service_error',
        liveness: {
          passed: false,
          confidence: 0,
          laplacian_var: 0,
          lbp_variance: 0,
          brightness: 0,
          reasons: ['Service unavailable'],
        },
        quality: {
          passed: false,
          laplacian_var: 0,
          brightness: 0,
          face_area_ratio: 0,
          face_count: 0,
          reasons: ['Service unavailable'],
        },
      };
    }

    // Combined decision: quality AND (match OR enrollment) AND liveness must
    // pass. In enrollment mode the selfie is its own reference, so a 1:1
    // self-match is expected and we decide on quality + liveness only.
    const qualityPassed = result.quality?.passed ?? false;
    const matchPassed = args.isEnrollment ? true : result.match === true;
    const livenessPassed = result.liveness?.passed ?? false;
    const passed = qualityPassed && matchPassed && livenessPassed;
    const flagged = !passed;

    // On a successful enrollment, persist the freshly computed descriptor
    // so subsequent checks can run a real identity match.
    if (!flagged && args.isEnrollment && Array.isArray((result as any)._descriptor)) {
      await pool.query(
        `UPDATE users SET face_enrollment_descriptor = $1 WHERE id = $2`,
        [(result as any)._descriptor, args.userId],
      );
    }

    await pool.query(
      `UPDATE users
         SET last_face_check_at = NOW(),
             last_face_check_score = $1,
             last_face_check_device_id = $2,
             face_check_status = $3
       WHERE id = $4`,
      [result.score, args.deviceId || null, flagged ? 'FLAGGED' : 'CLEAR', args.userId],
    );

    const eventRes = await pool.query(
      `INSERT INTO face_check_events
        (user_id, status, match_score,
         liveness_face_frames, liveness_motion_px, liveness_blink_count, liveness_laplacian_var,
         device_id, lat, lng)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        args.userId,
        flagged ? 'FLAGGED' : 'PASS',
        result.score,
        result.liveness?.passed ? 1 : 0,
        0,
        0,
        result.liveness?.laplacian_var ?? 0,
        args.deviceId || null,
        args.lat ?? null,
        args.lng ?? null,
      ],
    );
    const eventId = eventRes.rows[0].id;

    await pool.query(
      `INSERT INTO audit_logs (admin_id, target_id, action, details)
       VALUES (NULL, $1, 'FACE_CHECK', $2)`,
      [
        args.userId,
        JSON.stringify({
          status: flagged ? 'FLAGGED' : 'PASS',
          score: result.score,
          reason: result.reason,
          liveness_confidence: result.liveness?.confidence,
          quality_passed: qualityPassed,
          event_id: eventId,
        }),
      ],
    );

    if (flagged) {
      try {
        io.to('monitoring:all_rides').emit('faceCheckFlagged', {
          user_id: args.userId,
          event_id: eventId,
          score: result.score,
          reason: result.reason,
        });
      } catch {
        // io may not be initialized in test contexts.
      }

      // Notify admins (best-effort) so flagged checks are actionable.
      try {
        const driverRes = await pool.query(
          `SELECT full_name, email FROM users WHERE id = $1`,
          [args.userId],
        );
        const drow = driverRes.rows[0] || {};
        const adminEmail = env.ADMIN_NOTIFY_EMAIL;
        await EmailService.sendFaceCheckFlaggedNotice([{ email: adminEmail }], {
          driverName: drow.full_name,
          driverEmail: drow.email,
          reason: result.reason,
          score: result.score,
          eventId,
        });
      } catch (emailErr: any) {
        console.error('[FACE] admin notice error:', emailErr.message);
      }
    }

    return { ...result, flagged, eventId };
  },

  /**
   * Admin endpoint: clear or reject a flagged face check event.
   */
  async reviewEvent(args: {
    eventId: string;
    adminId: string;
    decision: 'APPROVED' | 'REJECTED';
    notes?: string;
  }): Promise<{ userId: string; cleared: boolean }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const evRes = await client.query(
        `SELECT user_id FROM face_check_events WHERE id = $1 FOR UPDATE`,
        [args.eventId],
      );
      if (evRes.rowCount === 0) throw new Error('Face check event not found');
      const userId = evRes.rows[0].user_id;

      await client.query(
        `UPDATE face_check_events
            SET reviewed_by_admin_id = $1,
                reviewed_at = NOW(),
                review_notes = $2,
                review_decision = $3
          WHERE id = $4`,
        [args.adminId, args.notes || null, args.decision, args.eventId],
      );

      const cleared = args.decision === 'APPROVED';
      if (cleared) {
        await client.query(
          `UPDATE users SET face_check_status = 'CLEAR' WHERE id = $1`,
          [userId],
        );
      } else {
        await client.query(
          `UPDATE users SET face_check_status = 'FLAGGED' WHERE id = $1`,
          [userId],
        );
      }

      await client.query(
        `INSERT INTO audit_logs (admin_id, target_id, action, details)
         VALUES ($1, $2, 'FACE_REVIEW', $3)`,
        [
          args.adminId,
          userId,
          JSON.stringify({
            event_id: args.eventId,
            decision: args.decision,
            notes: args.notes || null,
          }),
        ],
      );

      await client.query('COMMIT');

      try {
        io.to(`driver:${userId}`).emit('faceCheckStatusChanged', {
          status: cleared ? 'CLEAR' : 'FLAGGED',
        });
      } catch {}

      return { userId, cleared };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  async listFlaggedEvents(): Promise<any[]> {
    const res = await pool.query(
      `SELECT e.*, u.full_name, u.email, u.profile_image_url as profile_image_url
         FROM face_check_events e
         JOIN users u ON u.id = e.user_id
        WHERE e.status = 'FLAGGED' AND e.reviewed_at IS NULL
        ORDER BY e.created_at DESC
        LIMIT 100`,
    );
    return res.rows;
  },

  async listUserEvents(userId: string, limit = 20): Promise<any[]> {
    const res = await pool.query(
      `SELECT * FROM face_check_events
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, limit],
    );
    return res.rows;
  },

  /**
   * Admin-triggered face check. Forces the driver to re-verify on their next
   * app open (and immediately if connected) by flipping face_check_status to
   * FLAGGED and emitting a realtime event.
   */
  async forceFaceCheck(args: { userId: string; adminId: string }): Promise<{ userId: string; triggered: boolean }> {
    const userRes = await pool.query(
      `SELECT id, full_name, email FROM users WHERE id = $1`,
      [args.userId],
    );
    if (userRes.rowCount === 0) {
      throw new Error('User not found');
    }

    await pool.query(
      `UPDATE users
          SET face_check_status = 'FLAGGED',
              last_face_check_at = NULL
        WHERE id = $1`,
      [args.userId],
    );

    await pool.query(
      `INSERT INTO audit_logs (admin_id, target_id, action, details)
       VALUES ($1, $2, 'FACE_CHECK_TRIGGERED', $3)`,
      [
        args.adminId,
        args.userId,
        JSON.stringify({ admin_id: args.adminId, user_id: args.userId }),
      ],
    );

    try {
      io.to(`driver:${args.userId}`).emit('faceCheckRequired', {
        required: true,
        reason: 'flagged',
        faceCheckStatus: 'FLAGGED',
        lastFaceCheckAt: null,
      });
    } catch {
      // socket may be unavailable in test contexts
    }

    return { userId: args.userId, triggered: true };
  },
};
