// backend/src/services/face.service.ts
//
// All DB writes and business logic for face verification. Keeps the
// controller thin and gives us a single place to audit-log every event.

import { pool } from '../config/database';
import { env } from '../config/env';
import { PythonFaceClient, FaceVerifyResult } from './pythonClient';
import { io } from '../app';
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

    // Test-mode bypass: test/dev accounts bypass the face gate check to keep automated tests
    // and developer testing loops running smoothly without head-tracking/video-liveness constraints.
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
   * Run the Python microservice against a captured clip + reference image
   * and persist the result. Returns the verification outcome so the caller
   * can decide what UI to show.
   */
  async runVerification(args: {
    userId: string;
    videoBuffer: Buffer;
    videoMime: string;
    referenceBuffer: Buffer;
    referenceMime: string;
    deviceId?: string | null;
    lat?: number | null;
    lng?: number | null;
  }): Promise<FaceVerifyResult & { flagged: boolean; eventId: string | null }> {
    let result: FaceVerifyResult;
    try {
      result = await PythonFaceClient.verify({
        videoBuffer: args.videoBuffer,
        videoMime: args.videoMime,
        videoFilename: 'capture.mp4',
        referenceBuffer: args.referenceBuffer,
        referenceMime: args.referenceMime,
        referenceFilename: 'reference.jpg',
      });
    } catch (err: any) {
      console.error('[FACE] Python service error:', err.message);
      // Treat transport errors as a soft fail — escalate to admin.
      result = {
        match: false,
        score: 0,
        reason: 'service_error',
        liveness: {
          face_frames: 0,
          total_frames: 0,
          motion_px: 0,
          blink_count: 0,
          laplacian_var: 0,
          passed: false,
        },
      };
    }

    const passed = result.match === true && result.liveness.passed === true;
    const flagged = !passed;

    // 1) Update the user row.
    await pool.query(
      `UPDATE users
         SET last_face_check_at = NOW(),
             last_face_check_score = $1,
             last_face_check_device_id = $2,
             face_check_status = $3
       WHERE id = $4`,
      [result.score, args.deviceId || null, flagged ? 'FLAGGED' : 'CLEAR', args.userId],
    );

    // 2) Insert the event row (admin reviews flagged ones).
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
        result.liveness.face_frames,
        result.liveness.motion_px,
        result.liveness.blink_count,
        result.liveness.laplacian_var,
        args.deviceId || null,
        args.lat ?? null,
        args.lng ?? null,
      ],
    );
    const eventId = eventRes.rows[0].id;

    // 3) Audit log entry.
    await pool.query(
      `INSERT INTO audit_logs (admin_id, target_id, action, details)
       VALUES (NULL, $1, 'FACE_CHECK', $2)`,
      [
        args.userId,
        JSON.stringify({
          status: flagged ? 'FLAGGED' : 'PASS',
          score: result.score,
          reason: result.reason,
          event_id: eventId,
        }),
      ],
    );

    // 4) If flagged, notify admin via the monitoring room so the dashboard
    //    can show a real-time badge.
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
        // Approve = lift the flag, but don't reset last_face_check_at —
        // the driver must still re-verify on the next 12h tick.
        await client.query(
          `UPDATE users SET face_check_status = 'CLEAR' WHERE id = $1`,
          [userId],
        );
      } else {
        // Reject = keep the flag and the driver stays blocked.
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

      // Push the new state to the driver so the banner clears in real time.
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
};