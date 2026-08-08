// backend/src/modules/referral/referral.controller.ts
import { Response } from 'express';
import { z } from 'zod';
import { ReferralService, ReferralError } from './referral.service';

const DeviceSchema = z.object({
  deviceId: z.string().max(128).optional(),
  platform: z.string().max(32).optional(),
  deviceModel: z.string().max(64).optional(),
  appVersion: z.string().max(32).optional(),
}).optional();

const ScanReferralSchema = z.object({
  payload: z.string().max(1024).optional(),
  url: z.string().max(1024).optional(),
  code: z.string().max(32).optional(),
  device: DeviceSchema,
}).refine((d) => d.payload || d.url || d.code, { message: 'Missing referral payload, link or code' });

/**
 * Renders a ReferralError as a stable { error, code } response so the app
 * never parses English copy. Raw/Zod errors become generic fallbacks.
 */
function referralErrorResponse(res: Response, err: any) {
  if (err instanceof ReferralError) {
    return res.status(err.code === 'ALREADY_USED' ? 409 : 400).json({
      error: err.message,
      code: err.code,
    });
  }
  if (err?.name === 'ZodError') {
    return res.status(400).json({ error: 'That referral code does not look valid. Please check the code and try again.', code: 'INVALID_LINK' });
  }
  return res.status(400).json({ error: 'Something went wrong. Please try again later.', code: 'UNKNOWN' });
}

export class ReferralController {
  /** GET /api/referral — code, QR payload, URL, status + history. */
  static async info(req: any, res: Response) {
    try {
      const info = await ReferralService.ensureReferralCode(req.user.id);
      res.json(info);
    } catch (err: any) {
      referralErrorResponse(res, err);
    }
  }

  /**
   * POST /api/referral/scan
   *
   * Accepts a signed QR payload, a referral URL, or a raw manual code. All
   * fraud checks run server-side; the scanner is permanently linked on
   * success.
   */
  static async scan(req: any, res: Response) {
    try {
      const parsed = ScanReferralSchema.parse(req.body);
      const result = await ReferralService.scanReferral(req.user.id, parsed);
      res.status(201).json(result);
    } catch (err: any) {
      referralErrorResponse(res, err);
    }
  }

  /** GET /api/referral/history — referral status feed for the app. */
  static async history(req: any, res: Response) {
    try {
      const history = await ReferralService.getHistory(req.user.id);
      res.json({ history });
    } catch (err: any) {
      referralErrorResponse(res, err);
    }
  }

  /**
   * GET /api/referral/onboarding-status
   *
   * Backend-authoritative first-time referral gate. Registers the install id
   * (device fingerprint) and returns eligibility + risk state.
   */
  static async onboardingStatus(req: any, res: Response) {
    try {
      const parsed = DeviceSchema.parse(req.body?.device);
      const result = await ReferralService.getOnboardingStatus(req.user.id, parsed);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: 'Unable to load referral status. Please try again later.', code: 'UNKNOWN' });
    }
  }

  /** POST /api/referral/skip — permanently closes first-time onboarding. */
  static async skip(req: any, res: Response) {
    try {
      const result = await ReferralService.skipOnboarding(req.user.id);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: 'Unable to update your referral preference. Please try again later.', code: 'UNKNOWN' });
    }
  }
}
