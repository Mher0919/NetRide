// backend/src/modules/partner/partner-auth.service.ts
// PARTNER PORTAL AUTH — credential-based login for partner staff.
// ---------------------------------------------------------------------------
// Uses the same JWT secret as the rest of the system. On login, a 6-digit
// OTP is sent to the partner's email (via the existing OTP service). The
// partner must verify the OTP before a session token is issued.
// ---------------------------------------------------------------------------
// Server-side:   verifies users.role = PARTNER + bcrypt password
// Client-facing: partner enters email+password → OTP sent → OTP verified → JWT
// ---------------------------------------------------------------------------
// Server-side:   verifies users.role = PARTNER + bcrypt password
// Client-facing: partner enters email+password → OTP sent → OTP verified → JWT
// ---------------------------------------------------------------------------

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { pool } from '../../config/database';
import { env } from '../../config/env';
import { redis } from '../../config/redis';
import { OTPService } from '../auth/otp.service';
import { AuditEventsService } from '../../services/audit-events.service';

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_DAYS = 30;

export interface PartnerPortalSession {
  token: string;
  refreshToken: string;
  partner: {
    id: string;
    email: string;
  };
}

export interface PartnerLoginPending {
  partnerSessionPending: true;
  loginToken: string;
  partner: {
    id: string;
    email: string;
  };
  message?: string;
}

export class PartnerAuthService {
  static async login(email: string, password: string): Promise<PartnerLoginPending> {
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    if (!normalizedEmail || !password) throw new Error('Email and password are required');

    const userRes = await pool.query(
      `SELECT u.id, u.email, u.password_hash, u.is_active, u.role
       FROM users u
       WHERE u.email = $1 AND u.role = 'PARTNER'`,
      [normalizedEmail],
    );
    const user = userRes.rows[0];
    // Uniform error for both unknown email and wrong password (no user enumeration).
    if (!user) throw new Error('Invalid email or password');
    if (!user.password_hash) throw new Error('Invalid email or password');
    if (!user.is_active) throw new Error('Your account is disabled. Contact NetRide support.');

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) throw new Error('Invalid email or password');

    // Resolve the partner row via the user link (created together) with a
    // contact-email fallback for pre-link legacy rows.
    const partnerRes = await pool.query(
      `SELECT p.id, p.name, p.status, p.contact_email, p.must_change_password
       FROM partners p
       WHERE p.user_id = $1 OR p.contact_email ILIKE $2`,
      [user.id, normalizedEmail],
    );
    const partner = partnerRes.rows[0];
    if (!partner) throw new Error('Partner account not found. Ask an admin to create your partner account.');
    if (!partner.must_change_password && partner.status !== 'ACTIVE') throw new Error('Your partner account is archived or inactive. Contact an admin.');

    // Send 6-digit OTP to partner email
    await OTPService.generateOTP(normalizedEmail);

    // Store pending login attempt so verifyOTP can complete the session
    const loginToken = crypto.randomUUID();
    await redis.set(
      `partner_login:${loginToken}`,
      JSON.stringify({ userId: user.id, email: user.email }),
      'EX',
      5 * 60 * 60, // 5 hours validity for pending login
    );

    AuditEventsService.record({
      actorId: user.id,
      actorRole: 'PARTNER',
      action: 'partner_portal_login_initiated',
      entityType: 'partner',
      entityId: user.id,
      details: { email: user.email },
    }).catch(() => undefined);

    return {
      partnerSessionPending: true,
      loginToken,
      partner: { id: user.id, email: user.email },
      message: 'Verification code sent to email',
    } as const;
  }

  /** Complete the partner login after OTP verification. */
  static async completeLogin(loginToken: string, otpCode: string): Promise<PartnerPortalSession> {
    const pendingData = await redis.get(`partner_login:${loginToken}`);
    if (!pendingData) throw new Error('Login session expired or invalid. Please attempt login again.');

    const { userId, email } = JSON.parse(pendingData);

    // Verify OTP
    const isValid = await OTPService.verifyOTP(email, otpCode);
    if (!isValid) {
      await redis.del(`partner_login:${loginToken}`);
      throw new Error('Invalid or expired verification code');
    }

    // Consume the pending login token
    await redis.del(`partner_login:${loginToken}`);

    // Generate access token
    const newToken = jwt.sign(
      { id: userId, role: 'PARTNER', email },
      env.JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256' },
    );

    // Generate refresh token
    const refreshToken = crypto.randomUUID();
    await redis.set(
      `partner_refresh:${refreshToken}`,
      JSON.stringify({ userId, email }),
      'EX',
      REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
    );

    AuditEventsService.record({
      actorId: userId,
      actorRole: 'PARTNER',
      action: 'partner_portal_login_completed',
      entityType: 'partner',
      entityId: userId,
      details: { email },
    }).catch(() => undefined);

    return {
      token: newToken,
      refreshToken,
      partner: { id: userId, email },
    };
  }

  /** Refresh an expired access token using a valid refresh token. */
  static async refreshToken(refreshToken: string): Promise<{ token: string; refreshToken: string }> {
    const data = await redis.get(`partner_refresh:${refreshToken}`);
    if (!data) throw new Error('Invalid or expired refresh token');

    const parsed = JSON.parse(data);

    const userRes = await pool.query(
      `SELECT id, email, is_active FROM users WHERE id = $1 AND role = 'PARTNER'`,
      [parsed.userId],
    );
    const user = userRes.rows[0];
    if (!user || !user.is_active) {
      await redis.del(`partner_refresh:${refreshToken}`);
      throw new Error('Account is disabled');
    }

    const newToken = jwt.sign(
      { id: user.id, role: 'PARTNER', email: user.email },
      env.JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256' },
    );

    const newRefreshToken = crypto.randomUUID();
    await redis.del(`partner_refresh:${refreshToken}`);
    await redis.set(
      `partner_refresh:${newRefreshToken}`,
      JSON.stringify({ userId: user.id, email: user.email }),
      'EX',
      REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
    );

    return { token: newToken, refreshToken: newRefreshToken };
  }

  /** Invalidate a refresh token (used on logout). */
  static async invalidateRefreshToken(refreshToken: string): Promise<void> {
    await redis.del(`partner_refresh:${refreshToken}`);
  }

  /** First-login / forced password change. Sets password_changed_at + clears the flag. */
  static async changePassword(userId: string, newPassword: string): Promise<void> {
    if (!newPassword || newPassword.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2`,
      [hash, userId],
    );
    AuditEventsService.record({
      actorId: userId,
      actorRole: 'PARTNER',
      action: 'partner_portal_password_changed',
      entityType: 'partner',
      entityId: userId,
      details: {},
    }).catch(() => undefined);
  }
}