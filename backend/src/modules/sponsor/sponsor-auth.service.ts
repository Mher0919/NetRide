// backend/src/modules/sponsor/sponsor-auth.service.ts
//
// SPONSOR PORTAL AUTH — credential-based login for sponsor staff.
// ---------------------------------------------------------------------------
// Unlike riders (email OTP flow), the portal is a dedicated login with the
// same HS256 JWT secret but a SPONSOR role claim + sponsorId claim (spec
// §44-45). Everything is verified at login AND on every request:
//   - users row must exist, role = SPONSOR, is_active
//   - bcrypt password comparison (never plaintext)
//   - sponsor_portal_accounts row must be active
//   - sponsor must not be SUSPENDED
//   - must_change_password forces a password change on first login

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool } from '../../config/database';
import { env } from '../../config/env';
import { AuditEventsService } from '../../services/audit-events.service';

export interface SponsorPortalSession {
  token: string;
  sponsor: {
    id: string;
    businessName: string;
    email: string;
    mustChangePassword: boolean;
  };
}

export class SponsorAuthService {
  static async login(email: string, password: string): Promise<SponsorPortalSession> {
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    if (!normalizedEmail || !password) throw new Error('Email and password are required');

    const userRes = await pool.query(
      `SELECT u.id, u.email, u.password_hash, u.is_active, u.full_name
       FROM users u
       WHERE u.email = $1 AND u.role = 'SPONSOR'`,
      [normalizedEmail],
    );
    const user = userRes.rows[0];
    // Uniform error for both unknown email and wrong password (no user
    // enumeration).
    if (!user) throw new Error('Invalid email or password');
    if (!user.password_hash) throw new Error('Invalid email or password');

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) throw new Error('Invalid email or password');
    if (!user.is_active) throw new Error('Your account is disabled. Contact NetRide support.');

    const accountRes = await pool.query(
      `SELECT spa.sponsor_id, spa.is_active, spa.must_change_password
       FROM sponsor_portal_accounts spa
       JOIN sponsors s ON s.id = spa.sponsor_id
       WHERE spa.user_id = $1`,
      [user.id],
    );
    const account = accountRes.rows[0];
    if (!account || !account.is_active) throw new Error('Your account is disabled. Contact NetRide support.');
    if (!account.must_change_password) {
      const sponsorStatus = await pool.query(`SELECT status FROM sponsors WHERE id = $1`, [account.sponsor_id]);
      if (sponsorStatus.rows[0]?.status === 'SUSPENDED') {
        throw new Error('Your sponsor account is suspended. Contact NetRide support.');
      }
    }

    const token = jwt.sign(
      { id: user.id, role: 'SPONSOR', email: user.email, sponsorId: account.sponsor_id },
      env.JWT_SECRET,
      { expiresIn: '30d', algorithm: 'HS256' },
    );

    await pool.query(
      `UPDATE sponsor_portal_accounts SET last_login_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
      [user.id],
    );

    AuditEventsService.record({
      actorId: user.id,
      actorRole: 'SPONSOR',
      action: 'sponsor_portal_login',
      entityType: 'sponsor',
      entityId: account.sponsor_id,
      details: { email: user.email },
    }).catch(() => undefined);

    return {
      token,
      sponsor: {
        id: account.sponsor_id,
        businessName: user.full_name,
        email: user.email,
        mustChangePassword: account.must_change_password,
      },
    };
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
    const accountRes = await pool.query(`SELECT sponsor_id FROM sponsor_portal_accounts WHERE user_id = $1`, [userId]);
    if (accountRes.rows.length > 0) {
      await pool.query(
        `UPDATE sponsor_portal_accounts SET must_change_password = FALSE, updated_at = NOW() WHERE user_id = $1`,
        [userId],
      );
      AuditEventsService.record({
        actorId: userId,
        actorRole: 'SPONSOR',
        action: 'sponsor_portal_password_changed',
        entityType: 'sponsor',
        entityId: accountRes.rows[0].sponsor_id,
      }).catch(() => undefined);
    }
  }
}