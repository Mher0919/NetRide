// backend/src/modules/sponsor/specials.controller.ts
//
// RIDER-FACING SPECIALS API — the discovery + redemption lifecycle.
// Every money decision happens server-side; clients only signal intent.

import { Request, Response } from 'express';
import { pool } from '../../config/database';
import { SponsorService, discountLabelFor } from './sponsor.service';
import { SpecialRedemptionService } from './special-redemption.service';
import { AuthRequest } from '../../middleware/auth.middleware';

function publicSponsor(sponsor: any) {
  const { id, business_name, business_type, business_description, address, city,
          state, latitude, longitude, logo_url, cover_image_url,
          discount_type, discount_percent, max_discount_percent,
          discount_fixed_amount_cents, status } = sponsor;
  const kmAway = sponsor.km_away != null ? Number(sponsor.km_away) : null;
  return {
    id, businessName: business_name, businessType: business_type,
    businessDescription: business_description, address, city, state,
    latitude, longitude, logoUrl: logo_url, coverImageUrl: cover_image_url,
    discount: {
      type: discount_type,
      percent: discount_percent,
      maxPercent: max_discount_percent,
      fixedAmountCents: discount_fixed_amount_cents,
      label: discountLabelFor(sponsor),
    },
    kmAway,
    status,
  };
}

export class SpecialsController {
  /** GET /api/specials — eligible sponsors (SPECIALS list + map markers). */
  static async list(req: Request, res: Response) {
    try {
      const businessType = req.query.businessType as string | undefined;
      const lat = req.query.lat != null ? Number(req.query.lat) : undefined;
      const lng = req.query.lng != null ? Number(req.query.lng) : undefined;
      const limit = req.query.limit != null ? Number(req.query.limit) : 50;
      const offset = req.query.offset != null ? Number(req.query.offset) : 0;
      const rows = await SponsorService.listEligible({ businessType, lat, lng, limit, offset });
      res.json({ sponsors: rows.map(publicSponsor) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** GET /api/specials/count — eligible sponsor count (SPECIALS button visibility). */
  static async count(req: Request, res: Response) {
    try {
      const count = await SponsorService.countEligible();
      res.json({ count });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** GET /api/specials/:id — sponsor detail. */
  static async getOne(req: Request, res: Response) {
    try {
      const sponsor = await SponsorService.findById(req.params.id);
      if (!sponsor) return res.status(404).json({ error: 'Special not found' });
      const eligible = SponsorService.isEligible(sponsor);
      if (!eligible && sponsor.status !== 'ACTIVE') {
        return res.status(404).json({ error: 'Special not found' });
      }
      res.json({ sponsor: publicSponsor(sponsor), available: eligible });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** POST /api/specials/:id/redemption — rider picks a sponsor (step 1). */
  static async createRedemption(req: AuthRequest, res: Response) {
    try {
      const redemption = await SpecialRedemptionService.createForRider(req.user!.id, req.params.id);
      res.status(201).json({ redemption });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  /** GET /api/specials/redemptions/current — the rider's resumable redemption. */
  static async currentRedemption(req: AuthRequest, res: Response) {
    try {
      const redemption = await SpecialRedemptionService.findActiveForRider(req.user!.id);
      res.json({ redemption: redemption ?? null });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** GET /api/specials/redemptions/pending — open validation cards (one per completed special ride). */
  static async pendingRedemptions(req: AuthRequest, res: Response) {
    try {
      const redemptions = await SpecialRedemptionService.findPendingForRider(req.user!.id);
      res.json({ redemptions });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** POST /api/specials/redemptions/:id/verified — rider taps "I got verified". */
  static async markVerified(req: AuthRequest, res: Response) {
    try {
      const redemption = await SpecialRedemptionService.riderMarkedVerified(req.params.id, req.user!.id);
      res.json({ redemption, message: 'Waiting for the business to confirm your visit.' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  /** POST /api/specials/redemptions/:id/reward — rider picks REFUND or CREDITS. */
  static async chooseReward(req: AuthRequest, res: Response) {
    try {
      const { choice, confirmed } = req.body ?? {};
      const redemption = await SpecialRedemptionService.riderChooseReward(
        req.params.id,
        req.user!.id,
        choice,
        { confirmed },
      );
      res.json({ redemption });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  /** POST /api/specials/intro-seen — rider saw the SPECIALS intro (persisted §94). */
  static async markIntroSeen(req: AuthRequest, res: Response) {
    try {
      await pool.query(
        `UPDATE users SET specials_intro_seen_at = NOW() WHERE id = $1 AND specials_intro_seen_at IS NULL`,
        [req.user!.id],
      );
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** GET /api/specials/intro-state — has this rider seen the intro? */
  static async getIntroState(req: AuthRequest, res: Response) {
    try {
      const resq = await pool.query(`SELECT specials_intro_seen_at FROM users WHERE id = $1`, [req.user!.id]);
      res.json({ seen: !!resq.rows[0]?.specials_intro_seen_at });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
}