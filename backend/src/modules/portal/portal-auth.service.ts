// backend/src/modules/portal/portal-auth.service.ts
//
// UNIFIED PORTAL AUTH — one credential login for every portal account type:
//   SPONSOR  → sponsor_portal_accounts  (must_change_password on the account)
//   PARTNER  → partners                 (must_change_password on the partner row)
//   FLEET    → fleet_portal_accounts    (must_change_password on the account)
// The JWT carries role + portalType + portalId claims; every request is
// re-validated by portalMiddleware.

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { pool } from '../../config/database';
import { env } from '../../config/env';
import { redis } from '../../config/redis';
import { AuditEventsService } from '../../services/audit-events.service';

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_DAYS = 30;

export type PortalType = 'SPONSOR' | 'PARTNER' | 'FLEET';

export interface PortalSession {
  token: string;
  refreshToken: string;
  portal: {
    type: PortalType;
    id: string;
    name: string;
    email: string;
    mustChangePassword: boolean;
  };
}

interface AccountInfo {
  portalId: string;
  name: string;
  mustChangePassword: boolean;
  disabled: boolean;
  disabledMessage: string;
}

async function resolveAccount(user: any): Promise<AccountInfo> {
  if (user.role === 'SPONSOR') {
    const r = await pool.query(
      `SELECT spa.sponsor_id, spa.is_active, spa.must_change_password,
              s.status AS sponsor_status, u.full_name
       FROM sponsor_portal_accounts spa
       JOIN sponsors s ON s.id = spa.sponsor_id
       JOIN users u ON u.id = $1
       WHERE spa.user_id = $1`,
      [user.id],
    );
    const row = r.rows[0];
    if (!row || !row.is_active) {
      return { portalId: '', name: '', mustChangePassword: false, disabled: true, disabledMessage: 'Your portal account is disabled. Contact NetRide support.' };
    }
    if (!row.must_change_password && row.sponsor_status === 'SUSPENDED') {
      return { portalId: '', name: '', mustChangePassword: false, disabled: true, disabledMessage: 'Your sponsor account is suspended. Contact NetRide support.' };
    }
    return { portalId: row.sponsor_id, name: row.full_name, mustChangePassword: row.must_change_password, disabled: false, disabledMessage: '' };
  }

  if (user.role === 'PARTNER') {
    const r = await pool.query(
      `SELECT id, name, status, must_change_password, user_id
       FROM partners
       WHERE user_id = $1 OR contact_email ILIKE $2`,
      [user.id, user.email],
    );
    const row = r.rows[0];
    if (!row) {
      return { portalId: '', name: '', mustChangePassword: false, disabled: true, disabledMessage: 'Partner account not found. Contact NetRide support.' };
    }
    if (!row.must_change_password && row.status !== 'ACTIVE') {
      return { portalId: '', name: '', mustChangePassword: false, disabled: true, disabledMessage: 'Your partner account is not active. Contact NetRide support.' };
    }
    return { portalId: row.id, name: row.name, mustChangePassword: row.must_change_password, disabled: false, disabledMessage: '' };
  }

  if (user.role === 'FLEET') {
    const r = await pool.query(
      `SELECT fpa.fleet_id, fpa.is_active, fpa.must_change_password,
              f.is_active AS fleet_active, f.name
       FROM fleet_portal_accounts fpa
       JOIN fleet_partners f ON f.id = fpa.fleet_id
       WHERE fpa.user_id = $1`,
      [user.id],
    );
    const row = r.rows[0];
    if (!row || !row.is_active) {
      return { portalId: '', name: '', mustChangePassword: false, disabled: true, disabledMessage: 'Your fleet portal account is inactive. Contact NetRide support.' };
    }
    // An inactive fleet may still log in to change its password on first login.
    if (!row.must_change_password && !row.fleet_active) {
      return { portalId: '', name: '', mustChangePassword: false, disabled: true, disabledMessage: 'Your fleet is disabled. Contact NetRide support.' };
    }
    return { portalId: row.fleet_id, name: row.name, mustChangePassword: row.must_change_password, disabled: false, disabledMessage: '' };
  }

  return { portalId: '', name: '', mustChangePassword: false, disabled: true, disabledMessage: 'Portal access is not enabled for this account.' };
}

async function updateLastLogin(type: PortalType, userId: string) {
  if (type === 'SPONSOR') {
    await pool.query(`UPDATE sponsor_portal_accounts SET last_login_at = NOW(), updated_at = NOW() WHERE user_id = $1`, [userId]);
  } else if (type === 'FLEET') {
    await pool.query(`UPDATE fleet_portal_accounts SET last_login_at = NOW(), updated_at = NOW() WHERE user_id = $1`, [userId]);
  }
}

export class PortalAuthService {
  static async login(email: string, password: string): Promise<PortalSession> {
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    if (!normalizedEmail || !password) throw new Error('Email and password are required');

    const userRes = await pool.query(
      `SELECT id, email, password_hash, is_active, full_name, role FROM users WHERE email = $1`,
      [normalizedEmail],
    );
    const user = userRes.rows[0];
    if (!user || !user.password_hash) throw new Error('Invalid email or password');
    if (!['SPONSOR', 'PARTNER', 'FLEET'].includes(user.role)) {
      throw new Error('Invalid email or password');
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) throw new Error('Invalid email or password');
    if (!user.is_active) throw new Error('Your account is disabled. Contact NetRide support.');

    const account = await resolveAccount(user);
    if (account.disabled) throw new Error(account.disabledMessage);

    const portalType = user.role as PortalType;
    const token = jwt.sign(
      { id: user.id, role: user.role, email: user.email, portalType, portalId: account.portalId },
      env.JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256' },
    );

    const refreshToken = crypto.randomUUID();
    await redis.set(
      `portal_refresh:${refreshToken}`,
      JSON.stringify({ userId: user.id, email: user.email, portalType, portalId: account.portalId, mustChangePassword: account.mustChangePassword }),
      'EX',
      REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
    );

    await updateLastLogin(portalType, user.id);

    AuditEventsService.record({
      actorId: user.id,
      actorRole: user.role,
      action: 'portal_login',
      entityType: portalType.toLowerCase(),
      entityId: account.portalId,
      details: { email: user.email, portalType },
    }).catch(() => undefined);

    return {
      token,
      refreshToken,
      portal: {
        type: portalType,
        id: account.portalId,
        name: account.name,
        email: user.email,
        mustChangePassword: account.mustChangePassword,
      },
    };
  }

  static async refreshToken(refreshToken: string): Promise<{ token: string; refreshToken: string }> {
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

    const account = await resolveAccount(user);
    if (account.disabled) {
      await redis.del(`portal_refresh:${refreshToken}`);
      throw new Error(account.disabledMessage);
    }
    const portalType = user.role as PortalType;

    const newToken = jwt.sign(
      { id: user.id, role: user.role, email: user.email, portalType, portalId: account.portalId },
      env.JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256' },
    );

    const newRefreshToken = crypto.randomUUID();
    await redis.del(`portal_refresh:${refreshToken}`);
    await redis.set(
      `portal_refresh:${newRefreshToken}`,
      JSON.stringify({ userId: user.id, email: user.email, portalType, portalId: account.portalId, mustChangePassword: account.mustChangePassword }),
      'EX',
      REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
    );

    return { token: newToken, refreshToken: newRefreshToken };
  }

  static async invalidateRefreshToken(refreshToken: string): Promise<void> {
    await redis.del(`portal_refresh:${refreshToken}`);
  }

  /** First-login / forced password change. Clears the flag on the right account. */
  static async changePassword(userId: string, newPassword: string): Promise<void> {
    if (!newPassword || newPassword.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2`,
      [hash, userId],
    );

    const sponsor = await pool.query(`SELECT sponsor_id FROM sponsor_portal_accounts WHERE user_id = $1`, [userId]);
    if (sponsor.rows.length > 0) {
      await pool.query(
        `UPDATE sponsor_portal_accounts SET must_change_password = FALSE, updated_at = NOW() WHERE user_id = $1`,
        [userId],
      );
      AuditEventsService.record({
        actorId: userId, actorRole: 'SPONSOR', action: 'portal_password_changed',
        entityType: 'sponsor', entityId: sponsor.rows[0].sponsor_id,
      }).catch(() => undefined);
      return;
    }

    const fleet = await pool.query(`SELECT fleet_id FROM fleet_portal_accounts WHERE user_id = $1`, [userId]);
    if (fleet.rows.length > 0) {
      await pool.query(
        `UPDATE fleet_portal_accounts SET must_change_password = FALSE, updated_at = NOW() WHERE user_id = $1`,
        [userId],
      );
      AuditEventsService.record({
        actorId: userId, actorRole: 'FLEET', action: 'portal_password_changed',
        entityType: 'fleet', entityId: fleet.rows[0].fleet_id,
      }).catch(() => undefined);
      return;
    }

    const partner = await pool.query(`SELECT id FROM partners WHERE user_id = $1`, [userId]);
    if (partner.rows.length > 0) {
      await pool.query(`UPDATE partners SET must_change_password = FALSE, updated_at = NOW() WHERE user_id = $1`, [userId]);
      AuditEventsService.record({
        actorId: userId, actorRole: 'PARTNER', action: 'portal_password_changed',
        entityType: 'partner', entityId: partner.rows[0].id,
      }).catch(() => undefined);
    }
  }
}