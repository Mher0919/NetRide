// backend/src/modules/portal/portal-auth.service.ts
//
// UNIFIED PORTAL AUTH — one credential login for every portal account type:
//   SPONSOR  → sponsor_portal_accounts
//   PARTNER  → partners (linked via partners.user_id)
//   FLEET    → fleet_portal_accounts
//
// A single identity (email) can own ANY combination of account types — e.g.
// a business partner who also sponsors rides logs in once and switches
// between dashboards. Portal access is resolved from the account tables by
// user_id (never from users.role, which is a single legacy column). The JWT
// carries identity only; the ACTIVE portal type is chosen per request via
// the x-portal-type header (validated by portalMiddleware).

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { pool } from '../../config/database';
import { env } from '../../config/env';
import { redis } from '../../config/redis';
import { AuditEventsService } from '../../services/audit-events.service';
import { OTPService } from '../auth/otp.service';
import { findPortalIdentityByEmail, type PortalIdentity } from './portal-identities';

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_DAYS = 30;
/** How long a "remember this device" login skips the email 2FA code. */
const TRUSTED_DEVICE_TTL = '30d';
const TRUSTED_DEVICE_MARKER = 'portal-trusted';
/**
 * Server-side pending-login state created the moment a password check
 * succeeds but 2FA has not yet been completed. `verify2FA` only issues a
 * session for an email that has an ACTIVE pending login, so a valid code
 * alone can never mint a session — the password must have been verified
 * first. Lifetime matches the OTP code TTL (10 minutes).
 */
const PENDING_LOGIN_TTL_S = 10 * 60;

export type PortalType = 'SPONSOR' | 'PARTNER' | 'FLEET';

export interface PortalInfo {
  type: PortalType;
  id: string;
  name: string;
  email: string;
  mustChangePassword: boolean;
}

export interface PortalSession {
  token: string;
  refreshToken: string;
  portals: PortalInfo[];
  /** Default / previously active portal — kept for backward compat. */
  portal: PortalInfo;
}

const PORTAL_PRIORITY: PortalType[] = ['SPONSOR', 'PARTNER', 'FLEET'];

const PORTAL_ACCESS_DISABLED =
  'Your login is disabled. Contact NetRide support to restore access.';
const PORTAL_ACCESS_NOT_ENABLED =
  'Portal access is not enabled for this account. Contact NetRide support.';
const IDENTITY_DISABLED =
  'Your account is disabled. Contact NetRide support.';

interface PortalRowState {
  type: PortalType;
  id: string;
  name: string;
  mustChangePassword: boolean;
  blocked: boolean;
}

/**
 * All portal accounts attached to a PORTAL identity — including disabled
 * ones, so callers can distinguish "no portal access" from "access
 * disabled". Row-level status rules:
 *  - SPONSOR: a disabled portal row is a hard block; a SUSPENDED sponsor
 *    blocks access unless the password still has to be changed.
 *  - PARTNER: partner must be ACTIVE unless must_change_password. Partners
 *    are disabled/re-enabled via their partner status (no separate row flag).
 *  - FLEET: a disabled portal row is a hard block; an inactive fleet blocks
 *    access unless must_change_password.
 */
async function resolvePortalStates(userId: string, email: string): Promise<PortalRowState[]> {
  const res = await pool.query(
    `SELECT type, id, name, must_change_password, blocked
     FROM (
       SELECT 'SPONSOR'::text AS type, spa.sponsor_id::text AS id, u.full_name AS name,
              spa.must_change_password,
              ((NOT spa.is_active) OR (s.status = 'SUSPENDED' AND NOT spa.must_change_password)) AS blocked
       FROM sponsor_portal_accounts spa
       JOIN sponsors s ON s.id = spa.sponsor_id
       JOIN users u ON u.id = spa.user_id
       WHERE spa.user_id = $1
       UNION ALL
       SELECT 'PARTNER'::text AS type, p.id::text AS id, p.name AS name,
              p.must_change_password,
              (p.status <> 'ACTIVE' AND NOT p.must_change_password) AS blocked
       FROM partners p
       WHERE p.user_id = $1
       UNION ALL
       SELECT 'FLEET'::text AS type, fpa.fleet_id::text AS id, f.name AS name,
              fpa.must_change_password,
              ((NOT fpa.is_active) OR (NOT f.is_active AND NOT fpa.must_change_password)) AS blocked
       FROM fleet_portal_accounts fpa
       JOIN fleet_partners f ON f.id = fpa.fleet_id
       WHERE fpa.user_id = $1
     ) t
     ORDER BY CASE t.type WHEN 'SPONSOR' THEN 1 WHEN 'PARTNER' THEN 2 ELSE 3 END`,
    [userId],
  );

  return res.rows.map((r: any) => ({
    type: r.type as PortalType,
    id: r.id,
    name: r.name,
    mustChangePassword: r.must_change_password,
    blocked: r.blocked,
  }));
}

/** Unblocked portal accounts for a portal identity. */
async function resolvePortals(userId: string, email: string): Promise<PortalInfo[]> {
  const states = await resolvePortalStates(userId, email);
  return states
    .filter((r) => !r.blocked)
    .map((r) => ({
      type: r.type,
      id: r.id,
      name: r.name,
      email,
      mustChangePassword: r.mustChangePassword,
    }));
}

const REFRESH_TTL_SECONDS = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60;
const REFRESH_INDEX_TTL_SECONDS = REFRESH_TTL_SECONDS + 60;
const refreshKey = (token: string) => `portal_refresh:${token}`;
const refreshIndexKey = (userId: string) => `portal_refresh_index:${userId}`;

export class PortalAuthService {
  /** Issues access + refresh tokens for a resolved portal user (shared by login + 2FA). */
  private static async issueSession(
    user: { id: string; email: string; role: string },
    resolved?: PortalInfo[],
  ): Promise<PortalSession> {
    const portals = resolved ?? (await resolvePortals(user.id, user.email));
    if (portals.length === 0) {
      throw new Error(PORTAL_ACCESS_NOT_ENABLED);
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, email: user.email },
      env.JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256' },
    );

    const refreshToken = crypto.randomUUID();
    await redis.set(
      refreshKey(refreshToken),
      JSON.stringify({ userId: user.id, email: user.email, issuedAt: Date.now() }),
      'EX',
      REFRESH_TTL_SECONDS,
    );
    // Per-user index so a password change can revoke every outstanding
    // refresh token for the account (session invalidation on credential
    // change), not just the one that happened to be presented here.
    await redis
      .sadd(refreshIndexKey(user.id), refreshToken)
      .then(() => redis.expire(refreshIndexKey(user.id), REFRESH_INDEX_TTL_SECONDS))
      .catch(() => undefined);

    const portal = portals.find((p) => p.type === 'SPONSOR') ?? portals[0];

    AuditEventsService.record({
      actorId: user.id,
      actorRole: user.role,
      action: 'portal_login',
      entityType: 'portal',
      entityId: user.id,
      details: { email: user.email, types: portals.map((p) => p.type) },
    }).catch(() => undefined);

    return { token, refreshToken, portals, portal };
  }

  /** A 30-day "remember this device" token; expires → email 2FA required again. */
  static generateTrustedDeviceToken(user: { id: string; email: string; role: string }): string {
    return jwt.sign(
      { id: user.id, role: user.role, email: user.email, t: TRUSTED_DEVICE_MARKER },
      env.JWT_SECRET,
      { expiresIn: TRUSTED_DEVICE_TTL, algorithm: 'HS256' },
    );
  }

  static verifyTrustedDeviceToken(token: string): { id: string; email: string } | null {
    try {
      const decoded: any = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
      if (decoded?.t !== TRUSTED_DEVICE_MARKER) return null;
      return { id: String(decoded.id), email: String(decoded.email) };
    } catch {
      return null;
    }
  }

  static async login(
    email: string,
    password: string,
    trustedDeviceToken?: string | null,
  ): Promise<PortalSession | { otp_required: true; email: string; message: string }> {
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    if (!normalizedEmail || !password) throw new Error('Email and password are required');

    // Resolve ONLY the colab (portal-class) identity for this email. A driver
    // or rider account with the same email is a different identity and can
    // neither authenticate here nor influence this login's outcome.
    const user = await findPortalIdentityByEmail(normalizedEmail);
    if (!user || !user.password_hash) throw new Error('Invalid email or password');

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) throw new Error('Invalid email or password');
    if (!user.is_active) throw new Error(IDENTITY_DISABLED);

    const states = await resolvePortalStates(user.id, user.email);
    if (states.length === 0) throw new Error(PORTAL_ACCESS_NOT_ENABLED);
    const portals: PortalInfo[] = states
      .filter((s) => !s.blocked)
      .map((s) => ({
        type: s.type,
        id: s.id,
        name: s.name,
        email: user.email,
        mustChangePassword: s.mustChangePassword,
      }));
    if (portals.length === 0) throw new Error(PORTAL_ACCESS_DISABLED);

    // 2FA — skip the emailed code only for a remembered device (token valid ≤30 days).
    let isTrusted = false;
    if (trustedDeviceToken) {
      const decoded = this.verifyTrustedDeviceToken(trustedDeviceToken);
      if (decoded && decoded.id === user.id && decoded.email === user.email) {
        isTrusted = true;
      }
    }

    if (!isTrusted) {
      // Establish the pending 2FA state BEFORE generating the code so there
      // is never a code in circulation without a matching pending login.
      await redis.del(`portal_pending_login:${user.email}`);
      await redis.set(
        `portal_pending_login:${user.email}`,
        JSON.stringify({ userId: user.id }),
        'EX',
        PENDING_LOGIN_TTL_S,
      );
      await OTPService.generateOTP(user.email, 'PORTAL_LOGIN');
      return {
        otp_required: true,
        email: user.email,
        message: 'Verification code sent to your email',
      };
    }

    return this.issueSession(user, portals);
  }

  /**
   * Completes 2FA: requires an ACTIVE pending login (password previously
   * verified via login) plus a valid emailed code, then issues the portal
   * session. Any failure consumes the pending state, so replaying a code or
   * brute-forcing the endpoint forces a fresh credential submission.
   */
  static async verify2FA(
    email: string,
    code: string,
  ): Promise<PortalSession & { trustedDeviceToken: string }> {
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    const pendingKey = `portal_pending_login:${normalizedEmail}`;

    // No password-verified login in flight → no session, no exceptions.
    const pendingData = await redis.get(pendingKey);
    if (!pendingData) {
      throw new Error('Login session expired or invalid. Please sign in again.');
    }

    const isValid = await OTPService.verifyOTP(normalizedEmail, code, 'PORTAL_LOGIN');
    if (!isValid) {
      await redis.del(pendingKey);
      throw new Error('Invalid or expired verification code');
    }

    // Consume the pending state — each session requires a fresh login+2FA.
    await redis.del(pendingKey);

    const { userId } = JSON.parse(pendingData);
    const userRes = await pool.query(
      `SELECT id, email, is_active, role FROM users
       WHERE id = $1 AND email = $2 AND role IN ('SPONSOR','PARTNER','FLEET')`,
      [userId, normalizedEmail],
    );
    const user = userRes.rows[0];
    if (!user) throw new Error('Invalid email');
    if (!user.is_active) throw new Error(IDENTITY_DISABLED);

    const session = await this.issueSession(user);
    const trustedDeviceToken = this.generateTrustedDeviceToken(user);
    return { ...session, trustedDeviceToken };
  }

  static async refreshToken(refreshToken: string): Promise<{ token: string; refreshToken: string; portals: PortalInfo[]; portal: PortalInfo }> {
    const data = await redis.get(refreshKey(refreshToken));
    if (!data) throw new Error('Invalid or expired refresh token');

    const parsed = JSON.parse(data);

    const userRes = await pool.query(
      `SELECT id, email, is_active, role, password_changed_at FROM users
       WHERE id = $1 AND role IN ('SPONSOR','PARTNER','FLEET')`,
      [parsed.userId],
    );
    const user = userRes.rows[0];
    if (!user || !user.is_active) {
      await redis.del(refreshKey(refreshToken));
      throw new Error('Account is disabled');
    }

    // A refresh token issued before the last password change belongs to a
    // session established with the old credential and must not be renewed.
    if (user.password_changed_at) {
      let issuedAt = Number(parsed.issuedAt);
      if (!Number.isFinite(issuedAt) || issuedAt <= 0) {
        // Legacy payload without issuedAt: derive it from the remaining TTL.
        const ttl = await redis.ttl(refreshKey(refreshToken)).catch(() => -2);
        if (ttl > 0) issuedAt = Date.now() - (REFRESH_TTL_SECONDS - ttl) * 1000;
      }
      if (
        Number.isFinite(issuedAt) &&
        issuedAt > 0 &&
        new Date(user.password_changed_at).getTime() > issuedAt
      ) {
        await redis.del(refreshKey(refreshToken));
        throw new Error('Session expired. Please sign in again.');
      }
    }

    const states = await resolvePortalStates(user.id, user.email);
    const portals = states
      .filter((s) => !s.blocked)
      .map((s) => ({
        type: s.type,
        id: s.id,
        name: s.name,
        email: user.email,
        mustChangePassword: s.mustChangePassword,
      }));
    if (portals.length === 0) {
      await redis.del(refreshKey(refreshToken));
      throw new Error('Portal access is not enabled for this account.');
    }

    const newToken = jwt.sign(
      { id: user.id, role: user.role, email: user.email },
      env.JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256' },
    );

    // Rotation: the presented token is single-use and is replaced by a new
    // one (bound to the same user index).
    const newRefreshToken = crypto.randomUUID();
    await redis.del(refreshKey(refreshToken));
    await redis.srem(refreshIndexKey(user.id), refreshToken).catch(() => undefined);
    await redis.set(
      refreshKey(newRefreshToken),
      JSON.stringify({ userId: user.id, email: user.email, issuedAt: Date.now() }),
      'EX',
      REFRESH_TTL_SECONDS,
    );
    await redis
      .sadd(refreshIndexKey(user.id), newRefreshToken)
      .then(() => redis.expire(refreshIndexKey(user.id), REFRESH_INDEX_TTL_SECONDS))
      .catch(() => undefined);

    return {
      token: newToken,
      refreshToken: newRefreshToken,
      portals,
      portal: portals.find((p) => p.type === 'SPONSOR') ?? portals[0],
    };
  }

  static async invalidateRefreshToken(refreshToken: string): Promise<void> {
    const data = await redis.get(refreshKey(refreshToken)).catch(() => null);
    await redis.del(refreshKey(refreshToken));
    if (data) {
      try {
        const parsed = JSON.parse(data);
        if (parsed?.userId) {
          await redis.srem(refreshIndexKey(String(parsed.userId)), refreshToken);
        }
      } catch {
        // ignore malformed payloads
      }
    }
  }

  /**
   * Revokes every outstanding portal refresh token for the user. Called
   * whenever the credential changes (forced change / reset / admin action)
   * so sessions established with the old password cannot be renewed.
   */
  static async revokeAllRefreshTokens(userId: string): Promise<void> {
    try {
      const tokens = await redis.smembers(refreshIndexKey(userId));
      if (tokens.length > 0) {
        await redis.del(...tokens.map((t) => refreshKey(t)));
      }
      await redis.del(refreshIndexKey(userId));
    } catch (err: any) {
      console.warn(`[PORTAL] refresh-token revocation failed: ${err.message}`);
    }
  }

  /** First-login / forced password change. Clears the flag on ALL of the user's portal accounts. */
  static async changePassword(userId: string, newPassword: string): Promise<void> {
    if (!newPassword || newPassword.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    const hash = await bcrypt.hash(newPassword, 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2`,
        [hash, userId],
      );
      await client.query(
        `UPDATE sponsor_portal_accounts SET must_change_password = FALSE, updated_at = NOW() WHERE user_id = $1`,
        [userId],
      );
      await client.query(
        `UPDATE fleet_portal_accounts SET must_change_password = FALSE, updated_at = NOW() WHERE user_id = $1`,
        [userId],
      );
      await client.query(
        `UPDATE partners SET must_change_password = FALSE, updated_at = NOW() WHERE user_id = $1`,
        [userId],
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
    // Credential change ⇒ every existing portal session is revoked.
    await this.revokeAllRefreshTokens(userId);
    AuditEventsService.record({
      actorId: userId,
      actorRole: 'PORTAL',
      action: 'portal_password_changed',
      entityType: 'portal',
      entityId: userId,
    }).catch(() => undefined);
  }
}