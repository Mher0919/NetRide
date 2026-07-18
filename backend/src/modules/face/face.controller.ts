// backend/src/modules/face/face.controller.ts
import { Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest, adminMiddleware } from '../../middleware/auth.middleware';
import { pool } from '../../config/database';
import { env } from '../../config/env';
import { FaceService } from '../../services/face.service';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

export class FaceController {
  /**
   * GET /api/face/check-required
   */
  static async checkRequired(req: AuthRequest, res: Response) {
    const userId = req.user!.id;
    const deviceId =
      (req.header('X-Device-Id') as string | undefined) || null;
    const lat = req.query.lat ? Number(req.query.lat) : null;
    const lng = req.query.lng ? Number(req.query.lng) : null;

    const result = await FaceService.isCheckRequired(userId, {
      deviceId,
      onlineLat: lat,
      onlineLng: lng,
    });
    res.json(result);
  }

  /**
   * POST /api/face/verify  (multipart: video + reference)
   * Legacy multi-angle video flow — retired. The single-selfie flow
   * (/verify-image, handled in-process) replaced it. Kept as a clear
   * 400 so old clients get an actionable message instead of a crash.
   */
  static verify = [
    async (_req: AuthRequest, res: Response) => {
      res.status(400).json({
        error: 'The video verification flow is no longer supported. Please update the app to use the single-selfie face check.',
      });
    },
  ];

  /**
   * POST /api/face/verify-image  (multipart: selfie image + reference)
   * New single-selfie flow with quality validation + anti-spoofing.
   */
  static verifyImage = [
    upload.fields([
      { name: 'selfie', maxCount: 1 },
      { name: 'reference', maxCount: 1 },
    ]),
    async (req: AuthRequest, res: Response) => {
      try {
        const userId = req.user!.id;
        const deviceId =
          (req.header('X-Device-Id') as string | undefined) || null;
        const lat = req.body?.lat ? Number(req.body.lat) : null;
        const lng = req.body?.lng ? Number(req.body.lng) : null;

        const files = req.files as
          | { [k: string]: Express.Multer.File[] }
          | undefined;
        const selfieFile = files?.selfie?.[0];
        const referenceFile = files?.reference?.[0];

        if (!selfieFile) {
          return res
            .status(400)
            .json({ error: 'Missing selfie image.' });
        }

        // Persist the selfie to disk for admin review
        const clipDir = path.join(__dirname, '../../uploads/face', userId);
        fs.mkdirSync(clipDir, { recursive: true });
        const selfieFilename = `${uuidv4()}.jpg`;
        const selfiePath = path.join(clipDir, selfieFilename);
        fs.writeFileSync(selfiePath, selfieFile.buffer);
        const selfieUrl = `${env.APP_URL}/uploads/face/${userId}/${selfieFilename}`;

        // Resolve the trusted reference. We now match on the stored
        // face-api.js descriptor (JSONB). A first-time driver has none, so
        // this becomes an enrollment (quality + liveness only).
        let referenceDescriptor: number[] | null = null;
        let isEnrollment = false;

        if (referenceFile) {
          // Client supplied a reference image — still need its descriptor,
          // so we fall through to enrollment-style handling for the match.
          isEnrollment = true;
        } else {
          const refRes = await pool.query(
            `SELECT face_enrollment_descriptor, face_enrollment_url
               FROM users WHERE id = $1`,
            [userId],
          );
          const row = refRes.rows[0];
          if (Array.isArray(row?.face_enrollment_descriptor) && row.face_enrollment_descriptor.length > 0) {
            referenceDescriptor = row.face_enrollment_descriptor;
          } else {
            // No stored descriptor → first-time enrollment.
            isEnrollment = true;
          }
        }

        const result = await FaceService.runImageVerification({
          userId,
          imageBuffer: selfieFile.buffer,
          imageMime: selfieFile.mimetype || 'image/jpeg',
          imageFilename: 'selfie.jpg',
          referenceDescriptor,
          isEnrollment,
          deviceId,
          lat,
          lng,
        });

        // Persist the enrollment reference image + descriptor on success.
        if (!result.flagged) {
          const refBuffer = isEnrollment ? selfieFile.buffer : referenceFile?.buffer;
          if (refBuffer) {
            const refFilename = `${uuidv4()}.jpg`;
            const refPath = path.join(clipDir, refFilename);
            fs.writeFileSync(refPath, refBuffer);
            const refUrl = `${env.APP_URL}/uploads/face/${userId}/${refFilename}`;
            await pool.query(
              `UPDATE users
                  SET face_enrollment_url = $1,
                      last_device_id = COALESCE(NULLIF($2, ''), last_device_id)
                WHERE id = $3`,
              [refUrl, deviceId || null, userId],
            );
          }
        }

        res.json({
          status: result.flagged ? 'FLAGGED' : 'PASS',
          enrolled: isEnrollment && !result.flagged,
          match: result.match,
          score: result.score,
          reason: result.reason,
          liveness: result.liveness,
          quality: result.quality,
          eventId: result.eventId,
          selfieUrl: result.flagged ? selfieUrl : null,
        });
      } catch (err: any) {
        console.error('[FACE] verify-image error:', err.message);
        res.status(500).json({ error: 'Face verification failed. Please try again.' });
      }
    },
  ];

  // -------- Admin endpoints ------------------------------------------------

  static async listFlagged(req: AuthRequest, res: Response) {
    const rows = await FaceService.listFlaggedEvents();
    res.json({ events: rows });
  }

  static async review(req: AuthRequest, res: Response) {
    const adminId = req.user!.id;
    const { eventId } = req.params;
    const { decision, notes } = req.body || {};
    if (decision !== 'APPROVED' && decision !== 'REJECTED') {
      return res
        .status(400)
        .json({ error: 'Decision must be APPROVED or REJECTED.' });
    }
    try {
      const result = await FaceService.reviewEvent({
        eventId,
        adminId,
        decision,
        notes,
      });
      res.json({
        message: decision === 'APPROVED' ? 'Flag cleared.' : 'Flag retained.',
        ...result,
      });
    } catch (err: any) {
      console.error('[FACE] review error:', err.message);
      res.status(500).json({ error: 'Failed to record review.' });
    }
  }

  static async userEvents(req: AuthRequest, res: Response) {
    const userId =
      req.params.userId || (req.query.userId as string | undefined);
    if (!userId) return res.status(400).json({ error: 'userId required.' });
    const events = await FaceService.listUserEvents(userId);
    res.json({ events });
  }
}
