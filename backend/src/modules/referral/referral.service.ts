// backend/src/modules/referral/referral.service.ts
//
// REFERRAL SYSTEM — backend-controlled state machine + fraud prevention.
// ---------------------------------------------------------------------------
// State machine (status column on referral_relationships):
//
//   NOT_LINKED
//     │  scan of a signed QR payload (or referral URL)
//     ▼
//   QR_SCANNED ──▶ LINKED                    (permanent, same transaction)
//     │              │
//     │              ▼  referred rider requests their first ride
//     │            FIRST_RIDE_PENDING
//     │              │
//     │              ▼  first ride COMPLETED with finalized payment
//     │            FIRST_RIDE_COMPLETED
//     │              │
//     │              ▼  both $5 grants posted (single transaction)
//     └──▶ REWARD_GRANTED                    (terminal — never re-granted)
//
// Hard invariants enforced by schema + code:
//   - referred_user_id is UNIQUE ⇒ one referral per rider, forever.
//   - Self-referral and loops are rejected before any row is created and
//     are structurally impossible afterwards (a user can only ever be the
//     "referred" side of one relationship).
//   - referral_rewards.relationship_id is UNIQUE ⇒ exactly one reward.
//   - Rewards require a COMPLETED ride with a finalized payment and no
//     prior completed ride for that rider (anti-farming).
//   - QR payloads are HMAC-signed with expiry + ownership binding.

import { pool } from '../../config/database';
import { getIo } from '../../gateway/io-handle';
import { env } from '../../config/env';
import { isTestEmail } from '../../utils/testUser';
import {
  signReferralPayload,
  verifyReferralPayload,
  generateReferralCode,
} from '../../services/qr-signature.service';
import { CreditsService } from '../credits/credits.service';
import { AuditEventsService } from '../../services/audit-events.service';
import { DeviceRiskService, DeviceFingerprintInput } from '../../services/device-risk.service';
import {
  notifyReferralLinked,
  notifyReferralRewardGranted,
} from '../../services/notification.service';

export const REFERRAL_STATES = [
  'QR_SCANNED',
  'LINKED',
  'FIRST_RIDE_PENDING',
  'FIRST_RIDE_COMPLETED',
  'REWARD_GRANTED',
] as const;

export type ReferralStatus = (typeof REFERRAL_STATES)[number];

/**
 * Structured, user-safe error codes. The controller maps these to stable
 * HTTP responses ({ error, code }) so clients never rely on English message
 * matching — the Flutter app translates codes to friendly copy.
 */
export type ReferralErrorCode =
  | 'INVALID_PAYLOAD'
  | 'INVALID_LINK'
  | 'CODE_NOT_FOUND'
  | 'CODE_EXPIRED'
  | 'OWNER_MISMATCH'
  | 'REFERRER_UNAVAILABLE'
  | 'SELF_REFERRAL'
  | 'ALREADY_USED'
  | 'LOOP_NOT_ALLOWED'
  | 'REFERRALS_CLOSED'
  | 'MISSING_INPUT';

export class ReferralError extends Error {
  constructor(public code: ReferralErrorCode, message: string) {
    super(message);
    this.name = 'ReferralError';
  }
}

export interface ReferralInfo {
  code: string;
  qr_payload: string;
  referral_url: string;
  issued_at: Date;
  expires_at: Date;
  can_scan: boolean;
  relationship_status: ReferralStatus | null;
  referrer: { full_name: string } | null;
  referred_count: number;
  rewards_earned_cents: number;
  history: ReferralHistoryEntry[];
}

export interface ReferralHistoryEntry {
  id: string;
  friend_name: string | null;
  friend_email: string | null;
  status: ReferralStatus;
  scanned_at: Date;
  first_ride_completed_at: Date | null;
  reward_granted_at: Date | null;
  amount_cents: number;
}

function emitReferralEvent(userId: string, event: string, data: Record<string, unknown>) {
  try {
    getIo().to(`rider:${userId}`).emit(event, { ...data, timestamp: new Date().toISOString() });
  } catch (err: any) {
    console.warn(`[REFERRAL] ⚠️ socket emit failed: ${err.message}`);
  }
}

export class ReferralService {
  /**
   * Lazily creates (or refreshes) a rider's referral code + signed payload.
   * Idempotent — safe to call on every profile open.
   */
  static async ensureReferralCode(userId: string): Promise<ReferralInfo> {
    const existing = await pool.query(
      `SELECT * FROM referral_codes WHERE user_id = $1`,
      [userId],
    );

    let row = existing.rows[0];
    if (!row || new Date(row.expires_at).getTime() < Date.now()) {
      let code = row?.code ?? generateReferralCode();
      if (!row) {
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await pool.query(
              `INSERT INTO referral_codes (user_id, code, qr_payload, expires_at)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (code) DO NOTHING`,
              [userId, code, '', new Date()],
            );
            const check = await pool.query(`SELECT * FROM referral_codes WHERE user_id = $1`, [userId]);
            if (check.rows.length > 0) {
              row = check.rows[0];
              break;
            }
            code = generateReferralCode(); // collision — retry with a fresh code
          } catch (err: any) {
            console.warn(`[REFERRAL] ⚠️ code insert attempt failed: ${err.message}`);
          }
        }
      }
      if (!row) throw new Error('Unable to create referral code');
      // (Re)sign the payload with a fresh expiry.
      const expiresAt = new Date(Date.now() + env.REFERRAL_QR_TTL_DAYS * 24 * 60 * 60 * 1000);
      const payload = signReferralPayload(row.user_id, row.code, expiresAt);
      await pool.query(
        `UPDATE referral_codes SET qr_payload = $1, expires_at = $2, issued_at = NOW() WHERE user_id = $3`,
        [payload, expiresAt, userId],
      );
      row.qr_payload = payload;
      row.expires_at = expiresAt;
    }

    const userRes = await pool.query(
      `SELECT full_name FROM users WHERE id = $1`,
      [userId],
    );
    const history = await this.getHistory(userId);
    const rewards = await pool.query(
      `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total FROM referral_rewards WHERE referrer_id = $1`,
      [userId],
    );
    const asReferred = await pool.query(
      `SELECT status, referrer_id FROM referral_relationships WHERE referred_user_id = $1`,
      [userId],
    );

    const referrer =
      asReferred.rows[0]?.referrer_id != null
        ? (
            await pool.query(`SELECT full_name FROM users WHERE id = $1`, [
              asReferred.rows[0].referrer_id,
            ])
          ).rows[0] ?? null
        : null;

    return {
      code: row.code,
      qr_payload: row.qr_payload,
      referral_url: `${env.APP_URL}/r/${row.code}`,
      issued_at: row.issued_at,
      expires_at: row.expires_at,
      can_scan: asReferred.rows.length === 0,
      relationship_status: (asReferred.rows[0]?.status as ReferralStatus) ?? null,
      referrer,
      referred_count: history.filter((h) => h.status !== 'QR_SCANNED').length,
      rewards_earned_cents: Number(rewards.rows[0].total),
      history,
    };
  }

  static async getHistory(userId: string): Promise<ReferralHistoryEntry[]> {
    const res = await pool.query(
      `SELECT r.id, r.status, r.scanned_at, r.first_ride_completed_at, r.reward_granted_at,
              u.full_name AS friend_name, u.email AS friend_email,
              rr.amount_cents
       FROM referral_relationships r
       LEFT JOIN users u ON u.id = r.referred_user_id
       LEFT JOIN referral_rewards rr ON rr.relationship_id = r.id
       WHERE r.referrer_id = $1
       ORDER BY r.created_at DESC
       LIMIT 200`,
      [userId],
    );
    return res.rows.map((r: any) => ({
      id: r.id,
      friend_name: r.friend_name,
      friend_email: r.friend_email,
      status: r.status,
      scanned_at: r.scanned_at,
      first_ride_completed_at: r.first_ride_completed_at,
      reward_granted_at: r.reward_granted_at,
      amount_cents: Number(r.amount_cents ?? 0),
    }));
  }

  /**
   * Processes a referral scan. `input` is the signed QR payload, a referral
   * URL, or a raw manual code. All fraud guards live here; nothing is trusted
   * from the client. On success the rider is permanently linked AND their
   * referral_onboarding_state is set to 'USED' (one referral per rider, ever).
   * A rider who previously skipped the onboarding offer may still use a code
   * here — skipping is no longer permanent.
   */
  static async scanReferral(
    scannerId: string,
    input: { payload?: string; url?: string; code?: string; device?: DeviceFingerprintInput },
  ): Promise<{ relationship_id: string; status: ReferralStatus; referrer_name: string | null }> {
    // ---- 1. Resolve the referrer from payload / URL / manual code ---------
    let referrerUserId: string;
    let code: string;
    let source: 'qr' | 'link' | 'code' = 'qr';

    if (input.payload) {
      const verified = verifyReferralPayload(input.payload);
      if (!verified.ok) throw new ReferralError('INVALID_PAYLOAD', verified.reason);
      referrerUserId = verified.payload.userId;
      code = verified.payload.code;
    } else if (input.url) {
      const m = String(input.url).match(/\/r\/([A-Z2-9]+)$/i);
      if (!m) throw new ReferralError('INVALID_LINK', 'Invalid referral link');
      code = m[1].toUpperCase();
      const codeRow = await pool.query(
        `SELECT user_id, expires_at FROM referral_codes WHERE code = $1`,
        [code],
      );
      if (codeRow.rows.length === 0) {
        await AuditEventsService.record({
          actorId: scannerId, actorRole: 'RIDER',
          action: 'REFERRAL_REJECTED', entityType: 'REFERRAL_RELATIONSHIP',
          details: { reason: 'CODE_NOT_FOUND', source },
        });
        throw new ReferralError('CODE_NOT_FOUND', 'This referral code does not exist');
      }
      if (new Date(codeRow.rows[0].expires_at).getTime() < Date.now()) {
        throw new ReferralError('CODE_EXPIRED', 'This referral code has expired');
      }
      referrerUserId = codeRow.rows[0].user_id;
      source = 'link';
    } else if (input.code) {
      const normalized = String(input.code).trim().toUpperCase();
      if (!/^[A-Z2-9]{10}$/.test(normalized)) {
        throw new ReferralError('INVALID_LINK', 'That referral code does not look valid. Please check the code and try again.');
      }
      code = normalized;
      const codeRow = await pool.query(
        `SELECT user_id, expires_at FROM referral_codes WHERE code = $1`,
        [code],
      );
      if (codeRow.rows.length === 0) {
        await AuditEventsService.record({
          actorId: scannerId, actorRole: 'RIDER',
          action: 'REFERRAL_REJECTED', entityType: 'REFERRAL_RELATIONSHIP',
          details: { reason: 'CODE_NOT_FOUND', source: 'code' },
        });
        throw new ReferralError('CODE_NOT_FOUND', 'We could not find that referral code. Please check the code and try again.');
      }
      if (new Date(codeRow.rows[0].expires_at).getTime() < Date.now()) {
        throw new ReferralError('CODE_EXPIRED', 'This referral code has expired.');
      }
      referrerUserId = codeRow.rows[0].user_id;
      source = 'code';
    } else {
      throw new ReferralError('MISSING_INPUT', 'Missing referral payload');
    }

    // ---- 2. Ownership binding: payload user must own the code -------------
    const owner = await pool.query(
      `SELECT rc.user_id, rc.code, u.full_name, u.is_active
       FROM referral_codes rc
       JOIN users u ON u.id = rc.user_id
       WHERE rc.code = $1`,
      [code],
    );
    if (owner.rows.length === 0) throw new ReferralError('CODE_NOT_FOUND', 'This referral code does not exist');
    if (owner.rows[0].user_id !== referrerUserId) {
      throw new ReferralError('OWNER_MISMATCH', 'Invalid referral payload');
    }
    if (!owner.rows[0].is_active) throw new ReferralError('REFERRER_UNAVAILABLE', 'This referral account is unavailable');

    const referrerId = owner.rows[0].user_id;
    const referrerName = owner.rows[0].full_name;

    // ---- 3. Self referral is impossible --------------------------------
    if (referrerId === scannerId) {
      await AuditEventsService.record({
        actorId: scannerId, actorRole: 'RIDER',
        action: 'SELF_REFERRAL_ATTEMPT', entityType: 'REFERRAL_RELATIONSHIP',
        details: { source, referrer_id: referrerId },
      });
      throw new ReferralError('SELF_REFERRAL', 'This referral code cannot be used with your account.');
    }

    // ---- 3b. Skipping the onboarding offer is NOT binding — a rider who
    // skipped can still use a friend's referral code later from the account
    // page. Only an EXISTING relationship (or self-referral) blocks them. ---

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ---- 4. One referral per rider, forever ---------------------------
      const already = await client.query(
        `SELECT id FROM referral_relationships WHERE referred_user_id = $1`,
        [scannerId],
      );
      if (already.rows.length > 0) {
        await client.query('ROLLBACK');
        await AuditEventsService.record({
          actorId: scannerId, actorRole: 'RIDER',
          action: 'REFERRAL_ALREADY_USED', entityType: 'REFERRAL_RELATIONSHIP',
          details: { source, existing_relationship_id: already.rows[0].id },
        });
        throw new ReferralError('ALREADY_USED', 'You have already used a referral code on this account.');
      }

      // ---- 5. Loop prevention (belt & braces — impossible by schema) ----
      const loop = await client.query(
        `SELECT id FROM referral_relationships
         WHERE referrer_id = $1 AND referred_user_id = $2`,
        [scannerId, referrerId],
      );
      if (loop.rows.length > 0) {
        await client.query('ROLLBACK');
        throw new ReferralError('LOOP_NOT_ALLOWED', 'Referral loops are not allowed');
      }

      // ---- 6. Create the relationship (QR_SCANNED → LINKED) -------------
      const created = await client.query(
        `INSERT INTO referral_relationships (referrer_id, referred_user_id, status)
         VALUES ($1, $2, 'LINKED')
         ON CONFLICT (referred_user_id) DO NOTHING
         RETURNING id`,
        [referrerId, scannerId],
      );
      if (created.rows.length === 0) {
        await client.query('ROLLBACK');
        await AuditEventsService.record({
          actorId: scannerId, actorRole: 'RIDER',
          action: 'REFERRAL_ALREADY_USED', entityType: 'REFERRAL_RELATIONSHIP',
          details: { source },
        });
        throw new ReferralError('ALREADY_USED', 'You have already used a referral code on this account.');
      }
      const relationshipId = created.rows[0].id;

      // Close onboarding permanently for this rider.
      await client.query(
        `UPDATE users SET referral_onboarding_state = 'USED', updated_at = NOW() WHERE id = $1`,
        [scannerId],
      );

      await client.query('COMMIT');

      // ---- 7. Notify + audit (post-commit, best-effort) -----------------
      if (input.device?.deviceId) {
        await DeviceRiskService.registerDevice(scannerId, input.device).catch(() => undefined);
      }
      emitReferralEvent(scannerId, 'referralStatusChanged', {
        relationship_id: relationshipId,
        status: 'LINKED',
        role: 'referred',
      });
      emitReferralEvent(referrerId, 'referralStatusChanged', {
        relationship_id: relationshipId,
        status: 'LINKED',
        role: 'referrer',
      });
      notifyReferralLinked(scannerId, referrerName, relationshipId).catch((err: any) =>
        console.warn(`[REFERRAL] ⚠️ notification failed: ${err.message}`),
      );
      await AuditEventsService.record({
        actorId: scannerId,
        actorRole: 'RIDER',
        action: source === 'qr' ? 'REFERRAL_QR_SCANNED' : 'REFERRAL_CODE_ENTERED',
        entityType: 'REFERRAL_RELATIONSHIP',
        entityId: relationshipId,
        details: { referrer_id: referrerId, source },
      });
      await AuditEventsService.record({
        actorId: scannerId,
        actorRole: 'RIDER',
        action: 'REFERRAL_ACCEPTED',
        entityType: 'REFERRAL_RELATIONSHIP',
        entityId: relationshipId,
        details: { referrer_id: referrerId, referred_user_id: scannerId, source },
      });

      return { relationship_id: relationshipId, status: 'LINKED', referrer_name: referrerName };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Referred rider requested a ride → LINKED becomes FIRST_RIDE_PENDING.
   * Best-effort state marker; correctness never depends on it.
   */
  static async markFirstRideRequested(riderId: string): Promise<void> {
    try {
      const res = await pool.query(
        `UPDATE referral_relationships
         SET status = 'FIRST_RIDE_PENDING'
         WHERE referred_user_id = $1 AND status IN ('LINKED', 'FIRST_RIDE_PENDING')
         RETURNING id`,
        [riderId],
      );
      if (res.rows.length > 0) {
        await AuditEventsService.record({
          actorId: riderId,
          actorRole: 'RIDER',
          action: 'REFERRAL_REWARD_PENDING',
          entityType: 'REFERRAL_RELATIONSHIP',
          entityId: res.rows[0].id,
          details: { rider_id: riderId },
        });
      }
    } catch (err: any) {
      console.warn(`[REFERRAL] ⚠️ markFirstRideRequested failed: ${err.message}`);
    }
  }

  /**
   * First-time onboarding gate. The backend is the ONLY authority on whether
   * the onboarding OFFER is still shown:
   *   - a linked relationship → USED (accepted, forever)
   *   - referral_onboarding_state = 'SKIPPED' → SKIPPED (offer declined; the
   *     rider may still accept a referral later from the account page)
   *   - otherwise → ELIGIBLE
   * Also registers the rider's install id (device fingerprint) and computes
   * their device risk state — used at reward time, never to block onboarding.
   */
  static async getOnboardingStatus(
    userId: string,
    device?: DeviceFingerprintInput,
  ): Promise<{ eligible: boolean; state: 'ELIGIBLE' | 'SKIPPED' | 'USED'; device_risk: string }> {
    const user = await pool.query(
      `SELECT referral_onboarding_state, device_risk_state FROM users WHERE id = $1`,
      [userId],
    );
    const rel = await pool.query(
      `SELECT id FROM referral_relationships WHERE referred_user_id = $1`,
      [userId],
    );

    let state: 'ELIGIBLE' | 'SKIPPED' | 'USED';
    if (rel.rows.length > 0) state = 'USED';
    else if (user.rows[0]?.referral_onboarding_state === 'SKIPPED') state = 'SKIPPED';
    else state = 'ELIGIBLE';

    // A rider who has already completed a ride is by definition NOT a
    // first-time user. The referral offer is tied to the FIRST completed
    // ride, so onboarding is auto-closed for them — otherwise the gate
    // would keep showing the referral screen to riders who are long past
    // their first ride (legacy accounts created before this feature).
    // Self-healing + idempotent: once closed it stays closed.
    if (state === 'ELIGIBLE') {
      const completed = await pool.query(
        `SELECT 1 FROM rides WHERE rider_id = $1 AND status = 'COMPLETED' LIMIT 1`,
        [userId],
      );
      if (completed.rows.length > 0) {
        await pool.query(
          `UPDATE users SET referral_onboarding_state = 'SKIPPED', updated_at = NOW() WHERE id = $1`,
          [userId],
        );
        await AuditEventsService.record({
          actorId: userId,
          actorRole: 'RIDER',
          action: 'REFERRAL_CLOSED',
          entityType: 'REFERRAL_RELATIONSHIP',
          details: { reason: 'COMPLETED_RIDE_BEFORE_DECISION' },
        });
        state = 'SKIPPED';
      }
    }

    const risk = device?.deviceId
      ? await DeviceRiskService.registerDevice(userId, device)
      : (user.rows[0]?.device_risk_state ?? 'NORMAL');

    return { eligible: state === 'ELIGIBLE', state, device_risk: risk };
  }

  /**
   * Closes the rider's referral onboarding OFFER (skip). The rider can still
   * use a friend's referral code later from the account page — skipping is
   * not a permanent opt-out. Safe to call repeatedly; idempotent and never
   * throws.
   */
  static async skipOnboarding(userId: string): Promise<{ state: 'SKIPPED' | 'USED' }> {
    const rel = await pool.query(
      `SELECT id FROM referral_relationships WHERE referred_user_id = $1`,
      [userId],
    );
    const finalState = rel.rows.length > 0 ? 'USED' : 'SKIPPED';
    await pool.query(
      `UPDATE users SET referral_onboarding_state = $2, updated_at = NOW() WHERE id = $1`,
      [userId, finalState],
    );
    await AuditEventsService.record({
      actorId: userId,
      actorRole: 'RIDER',
      action: 'REFERRAL_SKIPPED',
      entityType: 'REFERRAL_RELATIONSHIP',
      details: { user_id: userId },
    });
    return { state: finalState };
  }

  /**
   * The heart of the reward pipeline. Called when a ride COMPLETED.
   * Grants $5 to the referrer AND $5 to the referred rider — exactly once —
   * in a single transaction guarded by referral_rewards.relationship_id
   * uniqueness + row locking.
   */
  static async processFirstRideCompleted(
    ride: { id: string; rider_id: string; driver_id: string | null; fare_amount: string | number | null },
  ): Promise<boolean> {
    const rewardCents = Math.round(Number(env.REFERRAL_REWARD_CENTS));
    if (rewardCents <= 0) return false;

    const client = await pool.connect();
    let granted = false;
    try {
      await client.query('BEGIN');

      // Lock the relationship — concurrent completions serialize here.
      const relRes = await client.query(
        `SELECT * FROM referral_relationships
         WHERE referred_user_id = $1
           AND status IN ('LINKED', 'FIRST_RIDE_PENDING', 'FIRST_RIDE_COMPLETED')
         FOR UPDATE`,
        [ride.rider_id],
      );
      const rel = relRes.rows[0];
      if (!rel) {
        await client.query('COMMIT');
        return false;
      }

      // Fraud guard: this must be the rider's FIRST completed ride.
      const prior = await pool.query(
        `SELECT COUNT(*)::int AS n FROM rides
         WHERE rider_id = $1 AND status = 'COMPLETED' AND id <> $2`,
        [ride.rider_id, ride.id],
      );
      if (Number(prior.rows[0].n) > 0) {
        await client.query('COMMIT');
        return false;
      }

      // Fraud guard: device-risk gate. BLOCKED installs are never rewarded;
      // REVIEW installs are rewarded but flagged in the audit trail. This is
      // the ONLY money-minting path, so the UI can never bypass the policy.
      const riderRisk = await client.query(
        `SELECT device_risk_state FROM users WHERE id = $1`,
        [ride.rider_id],
      );
      const riskState = riderRisk.rows[0]?.device_risk_state ?? 'NORMAL';
      if (riskState === 'BLOCKED') {
        await client.query(
          `UPDATE referral_relationships SET status = 'FIRST_RIDE_COMPLETED',
            first_ride_id = $1, first_ride_completed_at = NOW()
           WHERE id = $2`,
          [ride.id, rel.id],
        );
        await client.query('COMMIT');
        await AuditEventsService.record({
          actorId: ride.rider_id,
          actorRole: 'RIDER',
          action: 'REFERRAL_REWARD_REJECTED',
          entityType: 'REFERRAL_RELATIONSHIP',
          entityId: rel.id,
          details: {
            reason: 'DEVICE_RISK_BLOCKED',
            ride_id: ride.id,
            risk_state: riskState,
            amount_cents: rewardCents,
          },
        });
        return false;
      }

      // Fraud guard: test-account rides never mint real rewards.
      const emails = await client.query(
        `SELECT id, email FROM users WHERE id = ANY($1::uuid[])`,
        [[ride.rider_id, ride.driver_id].filter(Boolean)],
      );
      const riderEmail = emails.rows.find((r: any) => r.id === ride.rider_id)?.email ?? '';
      if (isTestEmail(riderEmail)) {
        await client.query('COMMIT');
        return false;
      }

      // Claim the reward slot BEFORE posting money. Concurrent callers
      // lose the race here and their transaction rolls back.
      const claim = await client.query(
        `INSERT INTO referral_rewards
           (relationship_id, referrer_id, referred_user_id, ride_id, amount_cents)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (relationship_id) DO NOTHING
         RETURNING id`,
        [rel.id, rel.referrer_id, ride.rider_id, ride.id, rewardCents],
      );
      if (claim.rows.length === 0) {
        await client.query('COMMIT');
        return false;
      }
      const rewardId = claim.rows[0].id;

      // Socket emits are deferred until after COMMIT (emitSocket: false) so a
      // rolled-back transaction never announces a phantom balance change.
      const refTx = await CreditsService.post(rel.referrer_id, rewardCents, 'REFERRAL_REWARD', {
        idempotencyKey: `referral:${rel.id}:referrer`,
        description: `Friend completed their first ride — referral reward`,
        referenceType: 'referral_relationship',
        referenceId: rel.id,
        rideId: ride.id,
        client,
        emitSocket: false,
      });
      const redTx = await CreditsService.post(ride.rider_id, rewardCents, 'REFERRAL_REWARD', {
        idempotencyKey: `referral:${rel.id}:referred`,
        description: `You completed your first ride — welcome bonus`,
        referenceType: 'referral_relationship',
        referenceId: rel.id,
        rideId: ride.id,
        client,
        emitSocket: false,
      });

      await client.query(
        `UPDATE referral_relationships
         SET status = 'REWARD_GRANTED',
             first_ride_id = $1,
             first_ride_completed_at = NOW(),
             reward_granted_at = NOW()
         WHERE id = $2`,
        [ride.id, rel.id],
      );
      await client.query(
        `UPDATE referral_rewards
         SET referrer_tx_id = $1, referred_tx_id = $2
         WHERE id = $3`,
        [refTx.transaction_id, redTx.transaction_id, rewardId],
      );

      await client.query('COMMIT');
      granted = true;

      // Post-commit notifications (best-effort).
      emitReferralEvent(rel.referrer_id, 'referralStatusChanged', {
        relationship_id: rel.id,
        status: 'REWARD_GRANTED',
        role: 'referrer',
      });
      emitReferralEvent(ride.rider_id, 'referralStatusChanged', {
        relationship_id: rel.id,
        status: 'REWARD_GRANTED',
        role: 'referred',
      });
      // Announce the balance changes that actually committed.
      try {
        getIo().to(`rider:${rel.referrer_id}`).emit('creditBalanceChanged', {
          balance_cents: refTx.balance_cents,
          delta_cents: refTx.delta_cents,
          type: 'REFERRAL_REWARD',
          timestamp: new Date().toISOString(),
        });
        getIo().to(`rider:${ride.rider_id}`).emit('creditBalanceChanged', {
          balance_cents: redTx.balance_cents,
          delta_cents: redTx.delta_cents,
          type: 'REFERRAL_REWARD',
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        console.warn(`[REFERRAL] ⚠️ balance socket emit failed: ${err.message}`);
      }
      // Persisted + deduplicated notification (records history, fans out to
      // every device, and emits the live socket feed). One per event.
      notifyReferralRewardGranted(rel.referrer_id, rewardCents, 'referrer', rel.id).catch(() => undefined);
      notifyReferralRewardGranted(ride.rider_id, rewardCents, 'referred', rel.id).catch(() => undefined);
      // Persisted + deduplicated notification history (the push above is the
      // legacy one-shot; this is the record that powers the in-app feed).
      notifyReferralRewardGranted(rel.referrer_id, rewardCents, 'referrer', rel.id).catch(() => undefined);
      notifyReferralRewardGranted(ride.rider_id, rewardCents, 'referred', rel.id).catch(() => undefined);
      await AuditEventsService.record({
        action: 'REFERRAL_REWARD_GRANTED',
        entityType: 'REFERRAL_REWARD',
        entityId: rewardId,
        details: {
          relationship_id: rel.id,
          ride_id: ride.id,
          referrer_id: rel.referrer_id,
          referred_user_id: ride.rider_id,
          amount_cents: rewardCents,
          risk_state: riskState,
        },
      });
    } catch (err: any) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      console.warn(`[REFERRAL] ⚠️ reward pipeline failed for ride ${ride.id}: ${err.message}`);
    } finally {
      client.release();
    }
    return granted;
  }

  // -------------------------------------------------------------------------
  // Admin analytics
  // -------------------------------------------------------------------------

  static async adminStats() {
    const stats = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM referral_codes) AS codes_issued,
         (SELECT COUNT(*)::int FROM referral_relationships) AS relationships_total,
         (SELECT COUNT(*)::int FROM referral_relationships WHERE status IN ('LINKED','FIRST_RIDE_PENDING')) AS pending_first_ride,
         (SELECT COUNT(*)::int FROM referral_relationships WHERE status = 'FIRST_RIDE_COMPLETED') AS first_ride_completed,
         (SELECT COUNT(*)::int FROM referral_relationships WHERE status = 'REWARD_GRANTED') AS rewarded,
         (SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM referral_rewards) AS total_reward_cents,
         (SELECT COUNT(DISTINCT referrer_id)::int FROM referral_relationships) AS active_referrers,
         (SELECT AVG(cnt)::numeric(10,2) FROM (SELECT COUNT(*) AS cnt FROM referral_relationships GROUP BY referrer_id) s) AS avg_per_referrer`,
    );
    const r = stats.rows[0];
    return {
      codes_issued: Number(r.codes_issued),
      relationships_total: Number(r.relationships_total),
      pending_first_ride: Number(r.pending_first_ride),
      first_ride_completed: Number(r.first_ride_completed),
      rewarded: Number(r.rewarded),
      total_reward_cents: Number(r.total_reward_cents),
      active_referrers: Number(r.active_referrers),
      avg_per_referrer: r.avg_per_referrer == null ? null : Number(r.avg_per_referrer),
    };
  }

  /** Admin: all relationships with names, filters + pagination. */
  static async adminList(status: string, search: string, limit = 50, offset = 0) {
    const res = await pool.query(
      `SELECT r.id, r.status, r.scanned_at, r.first_ride_completed_at, r.reward_granted_at,
              r.referrer_id, r.referred_user_id, r.first_ride_id,
              ru.full_name AS referrer_name, ru.email AS referrer_email,
              du.full_name AS referred_name, du.email AS referred_email,
              rr.amount_cents, rr.created_at AS reward_created_at
       FROM referral_relationships r
       LEFT JOIN users ru ON ru.id = r.referrer_id
       LEFT JOIN users du ON du.id = r.referred_user_id
       LEFT JOIN referral_rewards rr ON rr.relationship_id = r.id
       WHERE ($1 = '' OR r.status = $1)
         AND ($2 = '' OR ru.full_name ILIKE '%' || $2 || '%' OR du.full_name ILIKE '%' || $2 || '%'
              OR du.email ILIKE '%' || $2 || '%')
       ORDER BY r.created_at DESC
       LIMIT $3 OFFSET $4`,
      [status || '', search || '', Math.min(Math.max(limit, 1), 200), Math.max(offset, 0)],
    );
    return res.rows.map((r: any) => ({
      ...r,
      amount_cents: Number(r.amount_cents ?? 0),
    }));
  }

  /**
   * Admin: abuse candidates. Flags relationships where the referred rider
   * has cancelled most of their rides, has no completed ride, shares the
   * referrer's phone pattern, or where a referrer's network looks like a
   * closed loop. Best-effort heuristics — a human reviews.
   */
  static async adminAbuse() {
    const res = await pool.query(
      `WITH rel AS (
         SELECT r.id, r.referrer_id, r.referred_user_id, r.status,
                ru.email AS referrer_email, du.email AS referred_email,
                ru.phone_number AS referrer_phone, du.phone_number AS referred_phone,
                du.full_name AS referred_name
         FROM referral_relationships r
         LEFT JOIN users ru ON ru.id = r.referrer_id
         LEFT JOIN users du ON du.id = r.referred_user_id
       ),
       ride_stats AS (
         SELECT rider_id,
                COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
                COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
                COUNT(*)::int AS total
         FROM rides GROUP BY rider_id
       )
       SELECT rel.*, rs.cancelled, rs.completed, rs.total,
              (rel.referrer_phone IS NOT NULL AND rel.referrer_phone = rel.referred_phone) AS same_phone,
              (rel.referrer_email = rel.referred_email) AS same_email
       FROM rel
       LEFT JOIN ride_stats rs ON rs.rider_id = rel.referred_user_id
       WHERE rs.completed = 0
          OR (rs.total >= 3 AND rs.cancelled >= rs.total * 0.7)
          OR (rel.referrer_phone IS NOT NULL AND rel.referrer_phone = rel.referred_phone)
          OR (rel.referrer_email = rel.referred_email)
       ORDER BY rel.id
       LIMIT 200`,
    );
    return res.rows.map((r: any) => ({
      relationship_id: r.id,
      referrer_id: r.referrer_id,
      referred_user_id: r.referred_user_id,
      status: r.status,
      referrer_email: r.referrer_email,
      referred_email: r.referred_email,
      referred_name: r.referred_name,
      ride_cancelled: Number(r.cancelled ?? 0),
      ride_completed: Number(r.completed ?? 0),
      ride_total: Number(r.total ?? 0),
      flags: [
        r.same_phone ? 'same_phone' : null,
        r.same_email ? 'same_email' : null,
        Number(r.completed ?? 0) === 0 && Number(r.total ?? 0) > 0 ? 'no_completed_ride' : null,
        Number(r.total ?? 0) >= 3 && Number(r.cancelled ?? 0) >= Number(r.total ?? 0) * 0.7
          ? 'high_cancellation' : null,
      ].filter(Boolean),
    }));
  }
}
