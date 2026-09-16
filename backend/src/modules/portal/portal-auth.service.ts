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

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_DAYS = 30;
/** How long a "remember this device" login skips the email 2FA code. */
const TRUSTED_DEVICE_TTL = '30d';
const TRUSTED_DEVICE_MARKER = 'portal-trusted';

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

/**
 * All portal accounts attached to a user. Row-level status rules:
 *  - SPONSOR: portal account must be active; SUSPENDED sponsor blocks
 *    access unless the password still has to be changed.
 *  - PARTNER: partner must be ACTIVE unless must_change_password.
 *  - FLEET: portal account + fleet must be active unless must_change_password.
 */
async function resolvePortals(userId: string, email: string): Promise<PortalInfo[]> {
  const res = await pool.query(
    `SELECT type, id, name, must_change_password, blocked
     FROM (
       SELECT 'SPONSOR'::text AS type, spa.sponsor_id::text AS id, u.full_name AS name,
              spa.must_change_password,
              (s.status = 'SUSPENDED' AND NOT spa.must_change_password) AS blocked
       FROM sponsor_portal_accounts spa
       JOIN sponsors s ON s.id = spa.sponsor_id
       JOIN users u ON u.id = spa.user_id
       WHERE spa.user_id = $1 AND spa.is_active = TRUE
       UNION ALL
       SELECT 'PARTNER'::text AS type, p.id::text AS id, p.name AS name,
              p.must_change_password,
              (p.status <> 'ACTIVE' AND NOT p.must_change_password) AS blocked
       FROM partners p
       WHERE p.user_id = $1
       UNION ALL
       SELECT 'FLEET'::text AS type, fpa.fleet_id::text AS id, f.name AS name,
              fpa.must_change_password,
              ((NOT fpa.is_active OR NOT f.is_active) AND NOT fpa.must_change_password) AS blocked
       FROM fleet_portal_accounts fpa
       JOIN fleet_partners f ON f.id = fpa.fleet_id
       WHERE fpa.user_id = $1
     ) t
     ORDER BY CASE t.type WHEN 'SPONSOR' THEN 1 WHEN 'PARTNER' THEN 2 ELSE 3 END`,
    [userId],
  );

  return res.rows
    .filter((r: any) => !r.blocked)
    .map((r: any) => ({
      type: r.type as PortalType,
      id: r.id,
      name: r.name,
      email,
      mustChangePassword: r.must_change_password,
    }));
}

export class PortalAuthService {
  /** Issues access + refresh tokens for a resolved portal user (shared by login + 2FA). */
  private static async issueSession(user: { id: string; email: string; role: string }): Promise<PortalSession> {
    const portals = await resolvePortals(user.id, user.email);
    if (portals.length === 0) {
      throw new Error('Portal access is not enabled for this account. Contact NetRide support.');
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, email: user.email },
      env.JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256' },
    );

    const refreshToken = crypto.randomUUID();
    await redis.set(
      `portal_refresh:${refreshToken}`,
      JSON.stringify({ userId: user.id, email: user.email }),
      'EX',
      REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
    );

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

    const userRes = await pool.query(
      `SELECT id, email, password_hash, is_active, role FROM users WHERE email = $1`,
      [normalizedEmail],
    );
    const user = userRes.rows[0];
    if (!user || !user.password_hash) throw new Error('Invalid email or password');

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) throw new Error('Invalid email or password');
    if (!user.is_active) throw new Error('Your account is disabled. Contact NetRide support.');

    const portals = await resolvePortals(user.id, user.email);
    if (portals.length === 0) {
      throw new Error('Portal access is not enabled for this account. Contact NetRide support.');
    }

    // 2FA — skip the emailed code only for a remembered device (token valid ≤30 days).
    let isTrusted = false;
    if (trustedDeviceToken) {
      const decoded = this.verifyTrustedDeviceToken(trustedDeviceToken);
      if (decoded && decoded.id === user.id && decoded.email === user.email) {
        isTrusted = true;
      }
    }

    if (!isTrusted) {
      await OTPService.generateOTP(user.email);
      return {
        otp_required: true,
        email: user.email,
        message: 'Verification code sent to your email',
      };
    }

    return this.issueSession(user);
  }

  /** Completes 2FA: verifies the emailed code and issues the portal session. */
  static async verify2FA(
    email: string,
    code: string,
  ): Promise<PortalSession & { trustedDeviceToken: string }> {
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    const isValid = await OTPService.verifyOTP(normalizedEmail, code);
    if (!isValid) throw new Error('Invalid or expired verification code');

    const userRes = await pool.query(
      `SELECT id, email, is_active, role FROM users WHERE email = $1`,
      [normalizedEmail],
    );
    const user = userRes.rows[0];
    if (!user) throw new Error('Invalid email');
    if (!user.is_active) throw new Error('Your account is disabled. Contact NetRide support.');

    const session = await this.issueSession(user);
    const trustedDeviceToken = this.generateTrustedDeviceToken(user);
    return { ...session, trustedDeviceToken };
  }

  static async refreshToken(refreshToken: string): Promise<{ token: string; refreshToken: string; portals: PortalInfo[]; portal: PortalInfo }> {
    const data = await redis.get(`portal_refresh:${refreshToken}`);
    if (!data) throw new Error('Invalid or expired refresh token');

    const parsed = JSON.parse(data);

    const userRes = await pool.query(
      `SELECT id, email, is_active, role FROM users WHERE id = $1`,
      [parsed.userId],
    );
    const user = userRes.rows[0];
    if (!user || !user.is_active) {
      await redis.del(`portal_refresh:${refreshToken}`);
      throw new Error('Account is disabled');
    }

    const portals = await resolvePortals(user.id, user.email);
    if (portals.length === 0) {
      await redis.del(`portal_refresh:${refreshToken}`);
      throw new Error('Portal access is not enabled for this account.');
    }

    const newToken = jwt.sign(
      { id: user.id, role: user.role, email: user.email },
      env.JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256' },
    );

    const newRefreshToken = crypto.randomUUID();
    await redis.del(`portal_refresh:${refreshToken}`);
    await redis.set(
      `portal_refresh:${newRefreshToken}`,
      JSON.stringify({ userId: user.id, email: user.email }),
      'EX',
      REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
    );

    return {
      token: newToken,
      refreshToken: newRefreshToken,
      portals,
      portal: portals.find((p) => p.type === 'SPONSOR') ?? portals[0],
    };
  }

  static async invalidateRefreshToken(refreshToken: string): Promise<void> {
    await redis.del(`portal_refresh:${refreshToken}`);
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
    AuditEventsService.record({
      actorId: userId,
      actorRole: 'PORTAL',
      action: 'portal_password_changed',
      entityType: 'portal',
      entityId: userId,
    }).catch(() => undefined);
  }
}