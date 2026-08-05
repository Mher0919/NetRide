// backend/src/modules/referral/referral.controller.ts
import { Response } from 'express';
import { z } from 'zod';
import { ReferralService } from './referral.service';

const ScanReferralSchema = z.object({
  payload: z.string().max(1024).optional(),
  url: z.string().max(1024).optional(),
}).refine((d) => d.payload || d.url, { message: 'Missing referral payload or link' });

export class ReferralController {
  /** GET /api/referral — code, QR payload, URL, status + history. */
  static async info(req: any, res: Response) {
    try {
      const info = await ReferralService.ensureReferralCode(req.user.id);
      res.json(info);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to load referral info' });
    }
  }

  /**
   * POST /api/referral/scan
   *
   * Accepts a signed QR payload OR a referral URL. All fraud checks run
   * server-side; the scanner is permanently linked on success.
   */
  static async scan(req: any, res: Response) {
    try {
      const parsed = ScanReferralSchema.parse(req.body);
      const result = await ReferralService.scanReferral(req.user.id, parsed);
      res.status(201).json(result);
    } catch (err: any) {
      const status = err?.name === 'ZodError' ? 400 : 400;
      res.status(status).json({ error: err.message || 'Unable to process referral' });
    }
  }

  /** GET /api/referral/history — referral status feed for the app. */
  static async history(req: any, res: Response) {
    try {
      const history = await ReferralService.getHistory(req.user.id);
      res.json({ history });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to load referral history' });
    }
  }
}
