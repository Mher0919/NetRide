// backend/src/modules/promo/promo.controller.ts
import { Response } from 'express';
import { z } from 'zod';
import { computeEstimate } from '../../services/pricing.service';
import { validatePromo } from './promo.service';

const ValidatePromoSchema = z.object({
  code: z.string().trim().min(2).max(32),
  distanceMeters: z.number().positive().optional(),
  durationSeconds: z.number().positive().optional(),
});

export class PromoController {
  /**
   * POST /api/promo/validate
   *
   * RIDER-FACING PREVIEW ONLY. Returns whether the code could apply to a
   * fare of this size. The authoritative application happens server-side
   * at ride request — this endpoint never writes anything.
   */
  static async validate(req: any, res: Response) {
    try {
      const parsed = ValidatePromoSchema.parse(req.body);

      // Compute the fare the same way the request path will — the client's
      // estimate is never trusted for the discount math.
      const breakdown = computeEstimate({
        distanceMeters: parsed.distanceMeters ?? 10_000,
        durationSeconds: parsed.durationSeconds ?? 600,
      });
      const fareCents = Math.round(breakdown.totalFare * 100);

      const validation = await validatePromo(req.user.id, parsed.code, fareCents);

      if (!validation.valid) {
        return res.status(validation.code).json({
          valid: false,
          code: parsed.code.toUpperCase(),
          reason: validation.reason,
        });
      }

      res.json({
        valid: true,
        code: validation.promo.code,
        discount_cents: validation.discountCents,
        fare_cents: validation.fareCents,
        final_cents: validation.finalCents,
        discount_label:
          validation.promo.discount_type === 'PERCENTAGE'
            ? `${validation.promo.discount_value}% off`
            : `$${Number(validation.promo.discount_value).toFixed(2)} off`,
        partner_name: validation.promo.partner_name,
        max_discount_cents: Number(validation.promo.max_discount_cents),
      });
    } catch (err: any) {
      if (err?.name === 'ZodError') {
        return res.status(400).json({ valid: false, reason: 'Invalid request' });
      }
      res.status(400).json({ valid: false, reason: err.message || 'Unable to validate promo' });
    }
  }
}
