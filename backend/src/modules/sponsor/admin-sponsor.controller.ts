// backend/src/modules/sponsor/admin-sponsor.controller.ts
//
// ADMIN SPONSORS API — CRUD, budget ledger, financial history (60/40),
// analytics, portal account management. Sponsors see only their own data;
// admins see everything (spec §53-62).

import { Request, Response } from 'express';
import { pool } from '../../config/database';
import { centsValue } from '../../services/financial-ledger.service';
import {
  SponsorService,
  discountLabelFor,
  SponsorStatus,
  SPONSOR_MIN_LIVE_FUNDING_CENTS,
} from './sponsor.service';
import { SpecialRedemptionService } from './special-redemption.service';
import { StorageService } from '../../services/storage.service';
import { validateUploadMime } from '../../security/file-policy';
import { detectImageMime, imageMimeMatches } from '../../security/image-content';
import {
  GooglePlacesService,
  isValidPlaceId,
} from '../google-places/google-places.service';

interface AdminReq extends Request {
  user?: { id: string; role: string; email: string };
}

const VALID_BUSINESS_TYPES = [
  'RESTAURANT', 'CAFE', 'RETAIL', 'BAR', 'SERVICES', 'MEDICAL', 'AUTO', 'OTHER',
];

/** Price levels the manual-entry form may store. */
export const SPONSOR_PRICE_LEVELS = ['$', '$$', '$$$', '$$$$'] as const;

/** Max gallery photos per sponsor (logo is separate). */
export const SPONSOR_MAX_PHOTOS = 8;

/**
 * Parse an uploaded business-profile image reference. Only references to
 * NetRide's own storage route (`/api/files/<uuid>`, relative or absolute) are
 * accepted — the dashboard must never be able to point a business image at
 * arbitrary external content.
 */
export function parseStoredImageUrl(raw: unknown): { fileId: string; url: string } | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let pathname = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      pathname = new URL(trimmed).pathname;
    } catch {
      return null;
    }
  }
  const match = /^\/api\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(pathname);
  if (!match) return null;
  return { fileId: match[1].toLowerCase(), url: `/api/files/${match[1].toLowerCase()}` };
}

/** Validate an uploaded image reference AND that the stored file exists public. */
async function verifyStoredImage(raw: unknown): Promise<{ url: string } | { error: string }> {
  const parsed = parseStoredImageUrl(raw);
  if (!parsed) return { error: 'Image must be an uploaded NetRide file.' };
  const record = await StorageService.getFileRecord(parsed.fileId);
  if (!record) return { error: 'Uploaded image was not found.' };
  if (record.visibility !== 'public') {
    return { error: 'Uploaded image is not a public business image.' };
  }
  const mime = validateUploadMime(record.mimetype);
  if (!mime) return { error: 'Uploaded image has an unsupported format.' };
  return { url: parsed.url };
}

/**
 * Normalise the optional manual business-profile fields shared by create and
 * update. Returns a validated patch fragment or a client error.
 */
async function parseBusinessProfile(body: any): Promise<
  | {
      adminRating: number | null;
      adminRatingCount: number | null;
      priceLevel: string | null;
      photoUrls: string[];
      logoUrl: string | null | undefined;
    }
  | { error: string }
> {
  let adminRating: number | null = null;
  if (body.adminRating !== undefined && body.adminRating !== null && body.adminRating !== '') {
    const n = Number(body.adminRating);
    if (!Number.isFinite(n) || n < 0 || n > 5) {
      return { error: 'Rating must be a number between 0 and 5.' };
    }
    adminRating = Math.round(n * 10) / 10;
  }

  let adminRatingCount: number | null = null;
  if (body.adminRatingCount !== undefined && body.adminRatingCount !== null && body.adminRatingCount !== '') {
    const n = Number(body.adminRatingCount);
    if (!Number.isInteger(n) || n < 0 || n > 100_000_000) {
      return { error: 'Rating count must be a non-negative integer.' };
    }
    adminRatingCount = n;
  }

  let priceLevel: string | null = null;
  if (body.priceLevel !== undefined && body.priceLevel !== null && body.priceLevel !== '') {
    if (!(SPONSOR_PRICE_LEVELS as readonly string[]).includes(String(body.priceLevel))) {
      return { error: `Price level must be one of ${SPONSOR_PRICE_LEVELS.join(', ')}.` };
    }
    priceLevel = String(body.priceLevel);
  }

  const photoUrls: string[] = [];
  if (body.photoUrls !== undefined) {
    if (!Array.isArray(body.photoUrls)) return { error: 'photoUrls must be an array.' };
    if (body.photoUrls.length > SPONSOR_MAX_PHOTOS) {
      return { error: `At most ${SPONSOR_MAX_PHOTOS} photos are allowed.` };
    }
    for (const raw of body.photoUrls) {
      const verified = await verifyStoredImage(raw);
      if ('error' in verified) return verified;
      if (!photoUrls.includes(verified.url)) photoUrls.push(verified.url);
    }
  }

  let logoUrl: string | null | undefined;
  if (body.logoUrl !== undefined) {
    if (body.logoUrl === null || body.logoUrl === '') {
      logoUrl = null;
    } else {
      const verified = await verifyStoredImage(body.logoUrl);
      if ('error' in verified) return verified;
      logoUrl = verified.url;
    }
  }

  return { adminRating, adminRatingCount, priceLevel, photoUrls, logoUrl };
}

/** Normalised (`/api/files/:id`) image reference, or null. */
function normalizedRef(raw: unknown): string | null {
  const parsed = parseStoredImageUrl(raw);
  return parsed ? parsed.url : null;
}

/**
 * Delete public business images that were replaced by an update and are no
 * longer referenced by ANY sponsor. Runs after the database update; every
 * failure is logged and swallowed — a cleanup problem must never make the
 * admin's save look failed.
 */
async function cleanupReplacedImages(before: { logo_url: string | null; cover_image_url: string | null; photo_urls: string[] }, after: { logo_url: string | null; cover_image_url: string | null; photo_urls: string[] }): Promise<void> {
  const refsOf = (s: { logo_url: string | null; cover_image_url: string | null; photo_urls: string[] }) =>
    new Set(
      [normalizedRef(s.logo_url), normalizedRef(s.cover_image_url), ...s.photo_urls.map(normalizedRef)]
        .filter((u): u is string => !!u),
    );
  const afterRefs = refsOf(after);
  const removed = [...refsOf(before)].filter((u) => !afterRefs.has(u));

  for (const url of removed) {
    try {
      const parsed = parseStoredImageUrl(url);
      if (!parsed) continue;
      const inUse = await pool.query(
        `SELECT 1 FROM sponsors
          WHERE logo_url = $1 OR logo_url = $2
             OR cover_image_url = $1 OR cover_image_url = $2
             OR photo_urls @> $3::jsonb OR photo_urls @> $4::jsonb
          LIMIT 1`,
        [parsed.url, url, JSON.stringify([parsed.url]), JSON.stringify([url])],
      );
      if (inUse.rowCount) continue;
      const record = await StorageService.getFileRecord(parsed.fileId);
      if (record && record.visibility === 'public') {
        await StorageService.delete(parsed.fileId);
      }
    } catch (err: any) {
      console.warn(`[ADMIN] ⚠️ Sponsor image cleanup failed for ${url}: ${err.message}`);
    }
  }
}

export interface GoogleAssociation {
  googlePlaceId: string | null;
  googleBusinessName: string | null;
  googleBusinessCategory: string | null;
  googleBusinessLatitude: number | null;
  googleBusinessLongitude: number | null;
  googleBusinessAddress: string | null;
  googlePlacesSyncedAt: Date | null;
}

export type GoogleAssociationResult =
  | { error: string }
  | { value: GoogleAssociation }
  | { skip: true };

/**
 * Validates the client's Google business association without trusting any
 * client-supplied Place ID or metadata (spec §24): the Place ID must be a
 * real Google Place ID AND carry a valid HMAC selection token that THIS
 * backend issued from a live Google response. Everything stored comes from
 * the verified token, never from the request body's free-form fields.
 */
export function parseGoogleAssociation(body: any): GoogleAssociationResult {
  const placeId = body?.googlePlaceId;
  if (placeId === undefined) return { skip: true };
  if (placeId === null || placeId === '') {
    return {
      value: {
        googlePlaceId: null,
        googleBusinessName: null,
        googleBusinessCategory: null,
        googleBusinessLatitude: null,
        googleBusinessLongitude: null,
        googleBusinessAddress: null,
        googlePlacesSyncedAt: null,
      },
    };
  }
  if (!isValidPlaceId(placeId)) {
    return { error: 'Invalid Google Place ID.' };
  }
  const payload = GooglePlacesService.verifySelectionToken(body?.googleSelectionToken);
  if (!payload || payload.p !== placeId) {
    return { error: 'The selected Google business could not be verified. Please select it again.' };
  }
  return {
    value: {
      googlePlaceId: payload.p,
      googleBusinessName: payload.n ? payload.n.slice(0, 200) : null,
      googleBusinessCategory: payload.c ? payload.c.slice(0, 120) : null,
      googleBusinessLatitude: payload.la,
      googleBusinessLongitude: payload.ln,
      googleBusinessAddress: payload.a ? payload.a.slice(0, 400) : null,
      googlePlacesSyncedAt: new Date(),
    },
  };
}

export class AdminSponsorController {
  // ---------------------------------------------------------------- CRUD

  static async list(req: AdminReq, res: Response) {
    try {
      const { rows, total } = await SponsorService.listSponsors({
        search: String(req.query.search ?? ''),
        status: String(req.query.status ?? ''),
        limit: Number(req.query.limit ?? 50),
        offset: Number(req.query.offset ?? 0),
        includeTest: String(req.query.includeTest ?? '') === 'true',
      });
      res.json({ sponsors: rows.map((s) => ({
        ...s,
        discountLabel: discountLabelFor(s),
        spendableCents: s.remaining_budget_cents - s.reserved_budget_cents,
        isLive: SponsorService.isEligible(s),
        minFundingCents: SPONSOR_MIN_LIVE_FUNDING_CENTS,
      })), total });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getOne(req: AdminReq, res: Response) {
    try {
      const sponsor = await SponsorService.findById(req.params.id);
      if (!sponsor) return res.status(404).json({ error: 'Sponsor not found' });
      const portal = await SponsorService.getPortalAccountForSponsor(sponsor.id);
      const [ledger, financial, analytics] = await Promise.all([
        SponsorService.getLedger(sponsor.id, { limit: 100 }),
        SponsorService.getFinancialHistory(sponsor.id, { limit: 50 }),
        SponsorService.getAnalytics(sponsor.id,
          new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
          new Date()),
      ]);
      res.json({
        sponsor: {
          ...sponsor,
          discountLabel: discountLabelFor(sponsor),
          spendableCents: sponsor.remaining_budget_cents - sponsor.reserved_budget_cents,
          isLive: SponsorService.isEligible(sponsor),
          minFundingCents: SPONSOR_MIN_LIVE_FUNDING_CENTS,
          // Same classification the list uses (marker + email + portal user).
          is_test: await SponsorService.isTestSponsor(sponsor.id),
        },
        portalAccount: portal ? {
          email: portal.email,
          isActive: portal.is_active,
          mustChangePassword: portal.must_change_password,
          lastLoginAt: portal.last_login_at,
        } : null,
        ledger,
        financialHistory: financial,
        analytics,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async create(req: AdminReq, res: Response) {
    try {
      const b = req.body ?? {};
      if (!b.businessName?.trim()) return res.status(400).json({ error: 'Business name is required' });
      if (!['PERCENTAGE', 'FIXED_AMOUNT'].includes(b.discountType)) {
        return res.status(400).json({ error: 'Invalid discount type' });
      }
      if (b.businessType && !VALID_BUSINESS_TYPES.includes(String(b.businessType).toUpperCase())) {
        return res.status(400).json({ error: 'Invalid business type' });
      }
      if (b.discountType === 'PERCENTAGE') {
        const pct = Number(b.discountPercent);
        if (!(pct > 0 && pct <= 100)) return res.status(400).json({ error: 'Discount percent must be > 0 and <= 100' });
      } else {
        const cents = Math.round(Number(b.discountFixedAmountCents ?? 0));
        if (!(cents > 0)) return res.status(400).json({ error: 'Fixed discount must be > $0' });
      }
      const budget = Math.round(Number(b.initialBudgetCents ?? 0));
      if (!(budget >= SPONSOR_MIN_LIVE_FUNDING_CENTS)) {
        return res.status(400).json({
          error: `Initial funding must be at least $${(SPONSOR_MIN_LIVE_FUNDING_CENTS / 100).toFixed(2)}`,
        });
      }
      const lat = b.latitude != null && b.latitude !== '' ? Number(b.latitude) : null;
      const lng = b.longitude != null && b.longitude !== '' ? Number(b.longitude) : null;
      if (lat != null && (isNaN(lat) || lat < -90 || lat > 90)) {
        return res.status(400).json({ error: 'Latitude must be between -90 and 90' });
      }
      if (lng != null && (isNaN(lng) || lng < -180 || lng > 180)) {
        return res.status(400).json({ error: 'Longitude must be between -180 and 180' });
      }
      if ((lat == null) !== (lng == null)) {
        return res.status(400).json({ error: 'Both latitude and longitude are required together' });
      }

      const googleAssociation = parseGoogleAssociation(b);
      if ('error' in googleAssociation) {
        return res.status(400).json({ error: googleAssociation.error });
      }
      const google = 'value' in googleAssociation ? googleAssociation.value : null;

      const profile = await parseBusinessProfile(b);
      if ('error' in profile) return res.status(400).json({ error: profile.error });

      const sponsor = await SponsorService.create({
        businessName: b.businessName,
        businessType: b.businessType,
        businessDescription: b.businessDescription,
        managerName: b.managerName,
        phone: b.phone,
        email: b.email,
        otherContactInfo: b.otherContactInfo,
        address: b.address,
        city: b.city,
        state: b.state,
        postalCode: b.postalCode,
        country: b.country,
        latitude: lat,
        longitude: lng,
        logoUrl: profile.logoUrl ?? null,
        coverImageUrl: b.coverImageUrl ?? null,
        adminRating: profile.adminRating,
        adminRatingCount: profile.adminRatingCount,
        priceLevel: profile.priceLevel,
        photoUrls: profile.photoUrls,
        googlePlaceId: google?.googlePlaceId ?? null,
        googleBusinessName: google?.googleBusinessName ?? null,
        googleBusinessCategory: google?.googleBusinessCategory ?? null,
        googleBusinessLatitude: google?.googleBusinessLatitude ?? null,
        googleBusinessLongitude: google?.googleBusinessLongitude ?? null,
        googleBusinessAddress: google?.googleBusinessAddress ?? null,
        googlePlacesSyncedAt: google?.googlePlacesSyncedAt ?? null,
        discountType: b.discountType,
        discountPercent: b.discountPercent,
        maxDiscountPercent: b.maxDiscountPercent,
        discountFixedAmountCents: b.discountFixedAmountCents,
        initialBudgetCents: budget,
        createdByAdminId: req.user!.id,
      }, { id: req.user!.id, role: 'ADMIN' });
      res.status(201).json({ sponsor });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async update(req: AdminReq, res: Response) {
    try {
      const b = req.body ?? {};
      const before = await SponsorService.findById(req.params.id);
      if (!before) return res.status(404).json({ error: 'Sponsor not found' });
      const patch: Record<string, unknown> = {};
      const map: Record<string, string> = {
        businessName: 'business_name',
        businessDescription: 'business_description',
        managerName: 'manager_name',
        phone: 'phone',
        email: 'email',
        otherContactInfo: 'other_contact_info',
        address: 'address',
        city: 'city',
        state: 'state',
        postalCode: 'postal_code',
        country: 'country',
        latitude: 'latitude',
        longitude: 'longitude',
        coverImageUrl: 'cover_image_url',
        specialsEnabled: 'specials_enabled',
        mapListingEnabled: 'map_listing_enabled',
      };
      for (const [k, col] of Object.entries(map)) {
        if (b[k] !== undefined) patch[col] = b[k];
      }
      // logoUrl is validated through parseBusinessProfile (it must reference
      // an uploaded public NetRide file), never passed through raw.
      const profile = await parseBusinessProfile(b);
      if ('error' in profile) return res.status(400).json({ error: profile.error });
      if (b.logoUrl !== undefined) patch.logo_url = profile.logoUrl;
      if (b.adminRating !== undefined) patch.admin_rating = profile.adminRating;
      if (b.adminRatingCount !== undefined) patch.admin_rating_count = profile.adminRatingCount;
      if (b.priceLevel !== undefined) patch.price_level = profile.priceLevel;
      if (b.photoUrls !== undefined) patch.photo_urls = profile.photoUrls;
      if (b.discountType) patch.discount_type = b.discountType;
      if (b.discountPercent !== undefined) patch.discount_percent = b.discountPercent;
      if (b.maxDiscountPercent !== undefined) patch.max_discount_percent = b.maxDiscountPercent;
      if (b.discountFixedAmountCents !== undefined) patch.discount_fixed_amount_cents = b.discountFixedAmountCents;

      const lat = b.latitude != null && b.latitude !== '' ? Number(b.latitude) : null;
      const lng = b.longitude != null && b.longitude !== '' ? Number(b.longitude) : null;
      if (lat != null && (isNaN(lat) || lat < -90 || lat > 90)) {
        return res.status(400).json({ error: 'Latitude must be between -90 and 90' });
      }
      if (lng != null && (isNaN(lng) || lng < -180 || lng > 180)) {
        return res.status(400).json({ error: 'Longitude must be between -180 and 180' });
      }
      if ((lat == null) !== (lng == null)) {
        return res.status(400).json({ error: 'Both latitude and longitude are required together' });
      }
      if (b.latitude !== undefined || b.longitude !== undefined) {
        patch.latitude = lat;
        patch.longitude = lng;
      }

      const googleAssociation = parseGoogleAssociation(b);
      if ('error' in googleAssociation) {
        return res.status(400).json({ error: googleAssociation.error });
      }
      if ('value' in googleAssociation) {
        const g = googleAssociation.value;
        patch.google_place_id = g.googlePlaceId;
        patch.google_business_name = g.googleBusinessName;
        patch.google_business_category = g.googleBusinessCategory;
        patch.google_business_latitude = g.googleBusinessLatitude;
        patch.google_business_longitude = g.googleBusinessLongitude;
        patch.google_business_address = g.googleBusinessAddress;
        patch.google_places_synced_at = g.googlePlacesSyncedAt;
      }

      const sponsor = await SponsorService.update(req.params.id, patch);
      if (!sponsor) return res.status(404).json({ error: 'Sponsor not found' });

      // Clean up replaced business images ONLY after the new references were
      // persisted (best-effort; failures are logged, never surfaced as a
      // failed save).
      await cleanupReplacedImages(before, sponsor);

      res.json({ sponsor });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async setStatus(req: AdminReq, res: Response) {
    try {
      const status = String(req.params.status).toUpperCase() as SponsorStatus;
      const sponsor = await SponsorService.setStatus(req.params.id, status, { id: req.user!.id, role: 'ADMIN' });
      res.json({ sponsor });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async remove(req: AdminReq, res: Response) {
    try {
      const result = await SponsorService.deleteById(req.params.id, { id: req.user!.id, role: 'ADMIN' });
      res.json(result);
    } catch (err: any) {
      const notFound = err.message === 'Sponsor not found';
      res.status(notFound ? 404 : 400).json({ error: err.message || 'Unable to delete sponsor' });
    }
  }

  // ---------------------------------------------------------------- budget

  static async adjustBudget(req: AdminReq, res: Response) {
    try {
      const body = req.body ?? {};
      const amountCents = Math.round(Number(body.amount_cents ?? body.deltaCents ?? 0));
      const direction = String(body.direction ?? 'CREDIT').toUpperCase();
      const deltaCents = direction === 'DEBIT' ? -Math.abs(amountCents) : Math.abs(amountCents);
      const reason = String(body.reason ?? '');
      const sponsor = await SponsorService.adjustBudget(req.params.id, deltaCents, reason, { id: req.user!.id, role: 'ADMIN' });
      res.json({ sponsor });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async getLedger(req: AdminReq, res: Response) {
    try {
      const ledger = await SponsorService.getLedger(req.params.id, {
        limit: Number(req.query.limit ?? 100),
        offset: Number(req.query.offset ?? 0),
      });
      res.json({ ledger });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getFinancialHistory(req: AdminReq, res: Response) {
    try {
      const history = await SponsorService.getFinancialHistory(req.params.id, {
        limit: Number(req.query.limit ?? 50),
        offset: Number(req.query.offset ?? 0),
      });
      res.json({ history });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getAnalytics(req: AdminReq, res: Response) {
    try {
      const days = Math.min(Math.max(Number(req.query.days ?? 90), 1), 365);
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const analytics = await SponsorService.getAnalytics(req.params.id, from, new Date());
      res.json({ days, analytics });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  // ------------------------------------------------------- portal accounts

  static async createPortalAccount(req: AdminReq, res: Response) {
    try {
      const { email, user_mode, user_id } = req.body ?? {};
      const mode = user_mode === 'EXISTING' ? 'EXISTING' : user_mode === 'NEW' ? 'NEW' : 'AUTO';
      if (mode === 'EXISTING' && !user_id) return res.status(400).json({ error: 'Select an existing user to link.' });
      if (mode !== 'EXISTING' && !email) return res.status(400).json({ error: 'Email is required' });
      const crypto = await import('crypto');
      const password = crypto.randomBytes(12).toString('base64url').slice(0, 12);
      const result = await SponsorService.createPortalAccount(
        req.params.id,
        { email, userId: user_id, mode },
        password,
        { id: req.user!.id, role: 'ADMIN' },
      );
      res.status(201).json({
        message: result.linkedExisting
          ? 'Portal account linked to the existing user'
          : 'Portal account ready',
        email: result.email,
        linkedToExisting: result.linkedExisting,
        ...(result.linkedExisting ? {} : { temporaryPassword: result.password }),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async resetPortalPassword(req: AdminReq, res: Response) {
    try {
      const crypto = await import('crypto');
      const password = String(req.body?.password ?? crypto.randomBytes(12).toString('base64url').slice(0, 12));
      const result = await SponsorService.resetPortalPassword(req.params.id, password, { id: req.user!.id, role: 'ADMIN' });
      res.json({ message: 'Password reset', temporaryPassword: result.password });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async disablePortalAccount(req: AdminReq, res: Response) {
    try {
      await SponsorService.disablePortalAccount(req.params.id, { id: req.user!.id, role: 'ADMIN' });
      res.json({ message: 'Portal account disabled' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async enablePortalAccount(req: AdminReq, res: Response) {
    try {
      await SponsorService.enablePortalAccount(req.params.id, { id: req.user!.id, role: 'ADMIN' });
      res.json({ message: 'Portal account enabled' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  // ------------------------------------------------------- business images

  /**
   * Upload a sponsor business image (logo or gallery photo) as base64.
   *
   * Security: the declared MIME is verified against the actual bytes
   * (magic-number sniffing), size and count limits apply, and the stored
   * file is public business branding (it is rendered on the rider map).
   * The returned URL is the portable `/api/files/:id` reference that the
   * create/update payloads accept.
   */
  static async uploadBusinessImage(req: AdminReq, res: Response) {
    try {
      const { image, mimetype, kind } = req.body ?? {};
      const imageKind: 'logo' | 'photo' = kind === 'logo' ? 'logo' : 'photo';
      if (typeof image !== 'string' || !image.trim()) {
        return res.status(400).json({ error: 'image (base64) is required.' });
      }
      if (typeof mimetype !== 'string') {
        return res.status(400).json({ error: 'mimetype is required.' });
      }
      const declared = validateUploadMime(mimetype);
      if (!declared) {
        return res.status(415).json({
          error: 'Unsupported file type. Only JPEG, PNG, WebP and HEIC images are accepted.',
        });
      }

      const buffer = Buffer.from(image, 'base64');
      const maxBytes = imageKind === 'logo' ? 2 * 1024 * 1024 : 5 * 1024 * 1024;
      if (buffer.length === 0) {
        return res.status(400).json({ error: 'image is empty.' });
      }
      if (buffer.length > maxBytes) {
        return res.status(413).json({
          error: `File too large. Max ${imageKind === 'logo' ? '2MB for a logo' : '5MB per photo'}.`,
        });
      }

      const detected = detectImageMime(buffer);
      if (!detected || !imageMimeMatches(declared, detected)) {
        return res.status(415).json({
          error: 'The uploaded file is not a valid image in a supported format.',
        });
      }

      const { id, url } = await StorageService.upload(buffer, {
        userId: req.user!.id,
        fileType: imageKind === 'logo' ? 'sponsor_logo' : 'sponsor_photo',
        originalName: `sponsor-${imageKind}`,
        mimetype: detected,
        visibility: 'public',
      });

      res.status(201).json({ fileId: id, url });
    } catch (err: any) {
      console.error(`[ADMIN] ❌ Sponsor image upload error: ${err.message}`);
      res.status(500).json({ error: 'Failed to upload the image.' });
    }
  }

  /**
   * Delete an uploaded business image that is not yet referenced by any
   * sponsor (the create dialog's "remove" action, or a failed save). Images
   * that a sponsor still references are refused — replacing an image goes
   * through update, which cleans up the replaced file only after the new
   * record is persisted.
   */
  static async deleteBusinessImage(req: AdminReq, res: Response) {
    try {
      const parsed = parseStoredImageUrl(req.body?.url);
      if (!parsed) return res.status(400).json({ error: 'A valid uploaded image URL is required.' });

      const inUse = await pool.query(
        `SELECT 1 FROM sponsors
          WHERE logo_url = $1 OR cover_image_url = $1 OR photo_urls @> $2::jsonb
          LIMIT 1`,
        [parsed.url, JSON.stringify([parsed.url])],
      );
      if (inUse.rowCount) {
        return res.status(409).json({ error: 'This image is in use by a sponsor and cannot be deleted.' });
      }

      const record = await StorageService.getFileRecord(parsed.fileId);
      if (record) {
        if (record.visibility !== 'public') {
          return res.status(400).json({ error: 'Only public business images can be deleted here.' });
        }
        await StorageService.delete(parsed.fileId);
      }
      res.json({ deleted: true });
    } catch (err: any) {
      console.error(`[ADMIN] ❌ Sponsor image delete error: ${err.message}`);
      res.status(500).json({ error: 'Failed to delete the image.' });
    }
  }

  // ------------------------------------------------------- fleet portal accounts

  static async createFleetPortalAccount(req: AdminReq, res: Response) {
    try {
      const { email } = req.body ?? {};
      if (!email || !String(email).trim()) return res.status(400).json({ error: 'Email is required' });
      const crypto = await import('crypto');
      const password = crypto.randomBytes(12).toString('base64url').slice(0, 12);
      const result = await SponsorService.createFleetPortalAccount(
        req.params.id,
        String(email).trim().toLowerCase(),
        password,
        { id: req.user!.id, role: 'ADMIN' },
      );
      res.status(201).json({ message: 'Fleet portal account ready', email, temporaryPassword: result.password });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async resetFleetPortalPassword(req: AdminReq, res: Response) {
    try {
      const crypto = await import('crypto');
      const password = String(req.body?.password ?? crypto.randomBytes(12).toString('base64url').slice(0, 12));
      const result = await SponsorService.resetFleetPortalPassword(req.params.id, password, { id: req.user!.id, role: 'ADMIN' });
      res.json({ message: 'Password reset', temporaryPassword: result.password });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async disableFleetPortalAccount(req: AdminReq, res: Response) {
    try {
      await SponsorService.disableFleetPortalAccount(req.params.id, { id: req.user!.id, role: 'ADMIN' });
      res.json({ message: 'Fleet portal account disabled' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async enableFleetPortalAccount(req: AdminReq, res: Response) {
    try {
      await SponsorService.enableFleetPortalAccount(req.params.id, { id: req.user!.id, role: 'ADMIN' });
      res.json({ message: 'Fleet portal account enabled' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  // ------------------------------------------------------------- redemptions

  static async listRedemptions(req: AdminReq, res: Response) {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
      const offset = Math.max(Number(req.query.offset ?? 0), 0);
      const status = String(req.query.status ?? '');
      const params: unknown[] = [];
      let where = '1=1';
      if (status) {
        params.push(status.toUpperCase());
        where = `sr.status = $${params.length}`;
      }
      params.push(limit, offset);
      const resq = await pool.query(
        `SELECT sr.id, sr.status, sr.sponsor_name, sr.sponsor_id,
                sr.rider_id, sr.driver_id, sr.ride_id, sr.discount_label,
                sr.calculated_discount_cents, sr.reward_choice,
                sr.reward_amount_cents, sr.sponsor_funded_cents,
                sr.driver_allocation_cents, sr.netride_allocation_cents,
                sr.netride_bonus_cents, sr.ride_requested_at,
                sr.ride_completed_at, sr.sponsor_validated_at,
                sr.reward_processed_at, sr.cancellation_reason_code,
                sr.cancellation_reason_text, sr.reward_failed_reason,
                sr.created_at,
                u.full_name AS rider_name
         FROM special_redemptions sr
         JOIN users u ON u.id = sr.rider_id
         WHERE ${where}
         ORDER BY sr.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      res.json({ redemptions: resq.rows.map((r: any) => ({
        ...r,
        calculated_discount_cents: centsValue(r.calculated_discount_cents),
        reward_amount_cents: centsValue(r.reward_amount_cents),
        sponsor_funded_cents: centsValue(r.sponsor_funded_cents),
        driver_allocation_cents: centsValue(r.driver_allocation_cents),
        netride_allocation_cents: centsValue(r.netride_allocation_cents),
        netride_bonus_cents: centsValue(r.netride_bonus_cents),
      })) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
}