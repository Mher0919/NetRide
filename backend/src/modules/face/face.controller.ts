// backend/src/modules/face/face.controller.ts
import { Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { AuthRequest, adminMiddleware } from '../../middleware/auth.middleware';
import { pool } from '../../config/database';
import { env } from '../../config/env';
import { FaceService } from '../../services/face.service';
import { StorageService } from '../../services/storage.service';

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
   * Legacy multi-angle video flow — preserved for backward compatibility.
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

        const clipDir = path.join(__dirname, '../../uploads/face', userId);
        fs.mkdirSync(clipDir, { recursive: true });
        const clipFilename = `${uuidv4()}.mp4`;
        const clipPath = path.join(clipDir, clipFilename);
        fs.writeFileSync(clipPath, videoFile.buffer);
        const clipUrl = `${env.APP_URL}/uploads/face/${userId}/${clipFilename}`;

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

        // Reference image — either uploaded by client or fetched from DB.
        let referenceBuffer: Buffer = Buffer.alloc(0);
        let referenceMime = 'image/jpeg';
        if (referenceFile) {
          referenceBuffer = referenceFile.buffer;
          referenceMime = referenceFile.mimetype || 'image/jpeg';
        } else {
          const refRes = await pool.query(
            `SELECT face_enrollment_url, profile_image_url FROM users WHERE id = $1`,
            [userId],
          );
          const row = refRes.rows[0];
          const refUrls = [row?.face_enrollment_url, row?.profile_image_url].filter(Boolean);

          if (refUrls.length === 0) {
            return res.status(400).json({ error: 'No reference image found. Please enroll your face first.' });
          }

          let fetched = false;
          for (const rawUrl of refUrls) {
            try {
              let absoluteUrl: string;
              if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
                absoluteUrl = rawUrl;
              } else if (rawUrl.startsWith('/api/files/')) {
                const fileId = rawUrl.replace('/api/files/', '');
                const access = await StorageService.getAccessUrl(fileId);
                if (!access.url) continue;
                absoluteUrl = access.url;
                referenceMime = access.mimetype || 'image/jpeg';
              } else {
                absoluteUrl = `${env.APP_URL}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
              }

              const resp = await axios.get(absoluteUrl, { responseType: 'arraybuffer', timeout: 10000 });
              referenceBuffer = Buffer.from(resp.data);
              referenceMime = (resp.headers['content-type'] as string) || 'image/jpeg';
              fetched = true;
              break;
            } catch {
              // Try the next URL
            }
          }

          if (!fetched) {
            return res.status(400).json({ error: 'No reference image found. Please enroll your face first.' });
          }
        }

        const result = await FaceService.runImageVerification({
          userId,
          imageBuffer: selfieFile.buffer,
          imageMime: selfieFile.mimetype || 'image/jpeg',
          imageFilename: 'selfie.jpg',
          referenceBuffer,
          referenceMime,
          deviceId,
          lat,
          lng,
        });

        // Update enrollment reference on success (only if client uploaded a reference)
        if (!result.flagged && referenceFile) {
          const refFilename = `${uuidv4()}.jpg`;
          const refPath = path.join(clipDir, refFilename);
          fs.writeFileSync(refPath, referenceFile.buffer);
          const refUrl = `${env.APP_URL}/uploads/face/${userId}/${refFilename}`;
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
