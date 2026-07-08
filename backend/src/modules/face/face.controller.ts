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
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB ceiling for clip
});

export class FaceController {
  /**
   * GET /api/face/check-required
   *   Body: { lat?, lng? }
   *   Returns: { required, reason, faceCheckStatus, lastFaceCheckAt }
   *
   * The driver app calls this before flipping the offline switch and
   * before each login to decide whether to route into the face capture
   * screen.
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
   * POST /api/face/verify  (multipart: video + reference image)
   *
   * The captured clip is also persisted to disk so admin can review it
   * later when it gets flagged.
   */
  static verify = [
    upload.fields([
      { name: 'video', maxCount: 1 },
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
        const videoFile = files?.video?.[0];
        const referenceFile = files?.reference?.[0];

        if (!videoFile) {
          return res
            .status(400)
            .json({ error: 'Missing video capture.' });
        }
        if (!referenceFile) {
          return res
            .status(400)
            .json({ error: 'Missing reference image.' });
        }

        // Persist the clip to disk so admin can review flagged events.
        const clipDir = path.join(__dirname, '../../uploads/face', userId);
        fs.mkdirSync(clipDir, { recursive: true });
        const clipFilename = `${uuidv4()}.mp4`;
        const clipPath = path.join(clipDir, clipFilename);
        fs.writeFileSync(clipPath, videoFile.buffer);
        const clipUrl = `${env.APP_URL}/uploads/face/${userId}/${clipFilename}`;

        // Also save the latest enrollment image (overwrites).
        const refFilename = `${uuidv4()}.jpg`;
        const refPath = path.join(clipDir, refFilename);
        fs.writeFileSync(refPath, referenceFile.buffer);
        const refUrl = `${env.APP_URL}/uploads/face/${userId}/${refFilename}`;

        const result = await FaceService.runVerification({
          userId,
          videoBuffer: videoFile.buffer,
          videoMime: videoFile.mimetype || 'video/mp4',
          referenceBuffer: referenceFile.buffer,
          referenceMime: referenceFile.mimetype || 'image/jpeg',
          deviceId,
          lat,
          lng,
        });

        // Update enrollment + device id on success.
        if (!result.flagged) {
          await pool.query(
            `UPDATE users
               SET face_enrollment_url = $1,
                   last_device_id = COALESCE(NULLIF($2, ''), last_device_id)
             WHERE id = $3`,
            [refUrl, deviceId || null, userId],
          );
        }

        res.json({
          status: result.flagged ? 'FLAGGED' : 'PASS',
          match: result.match,
          score: result.score,
          reason: result.reason,
          liveness: result.liveness,
          eventId: result.eventId,
          clipUrl: result.flagged ? clipUrl : null,
        });
      } catch (err: any) {
        console.error('[FACE] verify error:', err.message);
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