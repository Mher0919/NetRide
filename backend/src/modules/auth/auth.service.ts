// backend/src/modules/auth/auth.service.ts
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../../config/env';
import { pool } from '../../config/database';
import { redis } from '../../config/redis';
import { EmailService } from '../../services/email.service';
import { SmsService } from '../../services/sms.service';
import { OTPService } from './otp.service';
import { UserRole } from '../../types';
import { PartnerService } from '../partner/partner.service';
import { resolveSessionRole, assertPublicSignupRole } from './role-resolution';
import { sanitizeUser } from '../../security/user-sanitize';
import crypto from 'crypto';

export class AuthService {
  /**
   * Server-side markers proving that a password/gate has been completed
   * before an emailed code may be exchanged for a session. A public
   * `/auth/request-otp` call never sets one, so an intercepted code alone
   * cannot authenticate a password-protected account.
   */
  private static loginChallengeKey(email: string): string {
    return `login_otp_challenge:${String(email).trim().toLowerCase()}`;
  }

  private static adminChallengeKey(email: string): string {
    return `admin_login_challenge:${String(email).trim().toLowerCase()}`;
  }

  /** SHA-256 digest of an opaque one-time token (tokens are never stored raw). */
  private static hashToken(token: string): string {
    return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
  }

  private static async setChallenge(key: string, ttlSeconds: number): Promise<void> {
    try {
      await redis.set(key, '1', 'EX', ttlSeconds);
    } catch (err: any) {
      // Fail closed: without a durable challenge marker the code must not be
      // redeemable. Throwing here aborts the login instead of weakening it.
      console.error(`[AUTH] challenge write failed: ${err.message}`);
      throw new Error('Unable to start verification. Please try again.');
    }
  }

  /**
   * True while a challenge marker is pending. The marker is only cleared
   * after a SUCCESSFUL verification, so a typo does not force the user
   * through the password step again (the code itself still has a 5-attempt
   * cap and the endpoint is rate-limited).
   */
  private static async hasChallenge(key: string): Promise<boolean> {
    try {
      return (await redis.get(key)) != null;
    } catch (err: any) {
      console.error(`[AUTH] challenge read failed: ${err.message}`);
      return false;
    }
  }

  private static async clearChallenge(key: string): Promise<void> {
    try {
      await redis.del(key);
    } catch {
      // best-effort; the marker expires with the code TTL
    }
  }
  static async requestPhoneOTP(userId: string, phoneNumber: string, role?: string) {
    // 1. Check if this phone is already verified for the SAME user
    //    (either on their rider profile via users table, or driver profile via drivers table)
    const userRes = await pool.query(
      `SELECT phone_number, phone_verified FROM users WHERE id = $1`, [userId]
    );
    if (userRes.rows[0]?.phone_number === phoneNumber && userRes.rows[0]?.phone_verified) {
      // Same user, same phone, already verified on rider side → auto-verify for driver
      if (role === 'DRIVER') {
        await pool.query(
          `UPDATE drivers SET phone_number = $1, phone_verified = true WHERE user_id = $2`,
          [phoneNumber, userId]
        );
      }
      return { auto_verified: true, message: 'Phone already verified on your account.' };
    }

    const driverRes = await pool.query(
      `SELECT phone_number, phone_verified FROM drivers WHERE user_id = $1`, [userId]
    );
    if (driverRes.rows[0]?.phone_number === phoneNumber && driverRes.rows[0]?.phone_verified) {
      // Same user, phone verified on the DRIVER profile. Mirror it onto the
      // RIDER profile (users row) so the rider onboarding is also satisfied
      // and the app routes straight into the main screen instead of looping
      // on a phone-verify step that the backend keeps auto-confirming.
      await pool.query(
        `UPDATE users SET phone_number = $1, is_verified = true, phone_verified = true WHERE id = $2`,
        [phoneNumber, userId]
      );
      return { auto_verified: true, message: 'Phone already verified on your account.' };
    }

    // 2. Check if phone belongs to a DIFFERENT user
    const otherUser = await pool.query(
      'SELECT id FROM users WHERE phone_number = $1 AND id != $2', [phoneNumber, userId]
    );
    if (otherUser.rows.length > 0) {
      throw new Error('This number is already registered to another account');
    }

    const otherDriver = await pool.query(
      'SELECT user_id FROM drivers WHERE phone_number = $1 AND user_id != $2', [phoneNumber, userId]
    );
    if (otherDriver.rows.length > 0) {
      throw new Error('This number is already registered to another account');
    }

    // 3. Normal Twilio flow
    return SmsService.sendVerificationCode(phoneNumber);
  }

  static async verifyPhoneOTP(userId: string, phoneNumber: string, code: string, role?: string) {
    const result = await SmsService.verifyCode(phoneNumber, code);
    if (result.status === 'approved') {
      if (role === 'DRIVER') {
        // Ensure drivers row exists (dual-role safety)
        const exists = await pool.query('SELECT 1 FROM drivers WHERE user_id = $1', [userId]);
        if (exists.rows.length === 0) {
          await pool.query('INSERT INTO drivers (user_id) VALUES ($1)', [userId]);
        }
        await pool.query(
          `UPDATE drivers SET phone_number = $1, phone_verified = true WHERE user_id = $2`,
          [phoneNumber, userId]
        );
      } else {
        await pool.query(
          'UPDATE users SET phone_number = $1, is_verified = true, phone_verified = true WHERE id = $2',
          [phoneNumber, userId]
        );
      }
      return { success: true, message: 'Phone number verified' };
    }
    throw new Error('Invalid or expired verification code');
  }

  static async signupWithPassword(data: {
    email: string;
    full_name: string;
    password: string;
    role: UserRole;
  }) {
    // Self-registration may only ever create RIDER/DRIVER accounts. ADMIN/
    // PARTNER/FLEET roles are provisioned by administrators.
    const role = assertPublicSignupRole(data.role);

    // Consumer signup checks only the CONSUMER identity namespace. A colab
    // (sponsor/partner/fleet) account may hold the same email — the two are
    // independent identities (migration 058).
    const existingRes = await pool.query(
      `SELECT id, full_name FROM users WHERE email = $1 AND role IN ('RIDER','DRIVER','ADMIN')`,
      [data.email],
    );
    if (existingRes.rows.length > 0) {
      // Enumeration-safe: the caller receives the exact same response as a
      // brand-new signup. The real account owner is emailed a password-reset
      // link so a legitimate returning user is never stranded.
      const existing = existingRes.rows[0];
      try {
        const token = uuidv4();
        await redis.set(
          `reset_token:${this.hashToken(token)}`,
          existing.id,
          'EX',
          3600,
        );
        await EmailService.sendPasswordResetLink(data.email, existing.full_name, token);
      } catch (err: any) {
        console.error(`[AUTH] existing-account signup notice failed: ${err.message}`);
      }
      return { otp_required: true, phone_number_required: true, message: 'Verification code sent to email' };
    }

    const passwordHash = await bcrypt.hash(data.password, 10);
    // The consumer identity and the role-specific profile are ONE logical
    // registration. Without a transaction a failed driver-row insert could
    // leave an authenticated user whose driver profile never existed — the
    // partial state that required a restart (or a fresh signup) to repair.
    const client = await pool.connect();
    let user: any;
    try {
      await client.query('BEGIN');
      const createRes = await client.query(
        `INSERT INTO users (email, full_name, password_hash, role, is_verified, is_active, password_changed_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING *`,
        [data.email, data.full_name, passwordHash, role, false, true]
      );
      user = createRes.rows[0];

      if (role === UserRole.DRIVER) {
        await client.query(
          'INSERT INTO drivers (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
          [user.id],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Bind the code to a completed signup: verifyOTP only redeems a LOGIN
    // code when a password-verified signup/login challenge is pending.
    await OTPService.generateOTP(data.email, 'LOGIN');
    await this.setChallenge(
      this.loginChallengeKey(data.email),
      Math.floor(OTPService.CODE_TTL_MS / 1000),
    );
    return { otp_required: true, phone_number_required: true, message: 'Verification code sent to email' };
  }

  static async loginWithPassword(data: { email: string; password?: string; trusted_device_token?: string | null; app_role?: string }) {
    // Driver/rider (consumer) login resolves ONLY consumer identities. A colab
    // account with the same email is a separate identity and must never be
    // authenticated by the rider/driver app (and vice versa).
    const userRes = await pool.query(
      `SELECT * FROM users WHERE email = $1 AND role IN ('RIDER','DRIVER','ADMIN')`,
      [data.email],
    );
    const user = userRes.rows[0];

    if (!user) {
      throw new Error('User not found');
    }

    if (!user.password_hash) {
      throw new Error('This account uses a different login method');
    }

    if (data.password) {
      const isValid = await bcrypt.compare(data.password, user.password_hash);
      if (!isValid) {
        throw new Error('Invalid password');
      }
    } else {
       throw new Error('Password is required');
    }

    if (!user.is_active) {
      await pool.query('UPDATE users SET is_active = true WHERE id = $1', [user.id]);
      user.is_active = true;
    }

    // Resolve the active role from the application context the client
    // supplies (app_role). This prevents a dual-role user who first signed up
    // as a Rider from receiving a RIDER token when launching the Driver App.
    const active = await this.resolveActiveRole(user.id, data.app_role);
    const token = this.generateToken(user, active.role);
    const phoneNumberRequired = !user.phone_number;

    // ADMIN 2FA Check
    if (user.role === UserRole.ADMIN) {
      // Check if device is trusted
      let isTrusted = false;
      if (data.trusted_device_token) {
        try {
          const decoded = this.verifyToken(data.trusted_device_token);
          if (
            decoded.email === user.email &&
            decoded.role === UserRole.ADMIN &&
            decoded.t === 'trusted-device'
          ) {
            isTrusted = true;
          }
        } catch (e) {
          // Token invalid or expired, ignore
        }
      }

      if (!isTrusted) {
        // Bind the pending 2FA challenge to THIS administrator's identity
        // BEFORE the code is generated. The code itself is bound to the
        // admin's address (purpose ADMIN_2FA) and only delivered to the
        // shared notification inbox — one admin's code can never be used to
        // complete another admin's login.
        await this.setChallenge(
          this.adminChallengeKey(user.email),
          Math.floor(OTPService.CODE_TTL_MS / 1000),
        );
        await OTPService.generateOTP(user.email, 'ADMIN_2FA', {
          deliverTo: env.ADMIN_NOTIFY_EMAIL || user.email,
        });
        return {
          otp_required: true,
          email: env.ADMIN_NOTIFY_EMAIL || user.email,
          message: 'Admin 2FA required. Code sent to the admin inbox.',
        };
      }
    }

    // Email OTP verification for every non-admin password login. The 6-digit
    // code is sent to the user's email; the app exchanges it via
    // /auth/verify-otp, which then issues the session token.
    if (user.role !== UserRole.ADMIN) {
      // Bind the pending login to a successful password check. /auth/request-otp
      // never sets this marker, so an obtained code alone cannot authenticate.
      await this.setChallenge(
        this.loginChallengeKey(user.email),
        Math.floor(OTPService.CODE_TTL_MS / 1000),
      );
      await OTPService.generateOTP(user.email, 'LOGIN');
      return {
        otp_required: true,
        message: 'Verification code sent to email',
      };
    }

    // Check password expiration (90 days)
    const expirationDays = 90;
    const passwordChangedAt = user.password_changed_at ? new Date(user.password_changed_at) : new Date(0);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - passwordChangedAt.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    const passwordExpired = diffDays > expirationDays;

    const onboarding = await this.getOnboardingStatus(user.id);
    return { user: sanitizeUser(user), token, phone_number_required: phoneNumberRequired, password_expired: passwordExpired, onboarding };
  }

  static async changePassword(
    userId: string,
    data: { currentPassword?: string, newPassword: string },
    activeRole?: string,
  ) {
    const userRes = await pool.query(
      'SELECT id, email, role, password_hash, password_changed_at FROM users WHERE id = $1',
      [userId],
    );
    const user = userRes.rows[0];

    if (!user) throw new Error('User not found');

    if (data.currentPassword) {
      if (!user.password_hash) throw new Error('Password not set for this account');
      const isValid = await bcrypt.compare(data.currentPassword, user.password_hash);
      if (!isValid) throw new Error('Current password incorrect');
    } else {
      // No current password supplied is only legitimate for the forced
      // rotation of an EXPIRED administrative password: the admin has just
      // completed password + 2FA login and the UI intentionally cannot ask
      // for the old password again. Every other caller must prove knowledge
      // of the current password.
      const changedAt = user.password_changed_at ? new Date(user.password_changed_at) : new Date(0);
      const expired = Date.now() - changedAt.getTime() > 90 * 24 * 60 * 60 * 1000;
      if (!(user.role === UserRole.ADMIN && expired)) {
        throw new Error('Current password is required');
      }
    }

    const newHash = await bcrypt.hash(data.newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2', [newHash, userId]);

    // Issue a fresh session token: every token issued before the change is
    // now rejected by assertTokenStillValid, and the caller (e.g. the admin
    // app finishing a forced rotation) needs a usable session.
    const role = activeRole ?? user.role;
    const token = this.generateToken(user, role);
    return { message: 'Password updated successfully', token };
  }

  static async forgotPassword(email: string) {
    // Consumer app password reset: only consumer identities. The colab portal
    // has its own reset flow and must not reset a driver/rider password (or
    // vice versa) even when the emails match.
    const userRes = await pool.query(
      `SELECT id, full_name FROM users WHERE email = $1 AND role IN ('RIDER','DRIVER','ADMIN')`,
      [email],
    );
    const user = userRes.rows[0];
    if (!user) throw new Error('If an account exists with this email, you will receive a reset link');

    const token = uuidv4();
    // Only the digest is stored: a Redis dump can never be replayed against
    // the reset endpoint. The raw token exists only inside the emailed link.
    await redis.set(`reset_token:${this.hashToken(token)}`, user.id, 'EX', 3600); // 1 hour

    await EmailService.sendPasswordResetLink(email, user.full_name, token);
    return { message: 'Password reset link sent to email' };
  }

  static async resetPassword(token: string, newPassword: string) {
    const hashed = this.hashToken(token);
    const resetKey = `reset_token:${hashed}`;
    const changeKey = `pwd_change_token:${hashed}`;
    // Accept both the "forgot password" token and the token issued by the
    // in-session "request password change" flow (which already proved the
    // current password + email ownership) — both are single-use.
    const userId = (await redis.get(resetKey)) ?? (await redis.get(changeKey));
    if (!userId) throw new Error('Invalid or expired reset token');

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2', [newHash, userId]);
    await redis.del(resetKey);
    await redis.del(changeKey);
    return { message: 'Password reset successfully' };
  }

  static async getOnboardingStatus(userId: string) {
    const userRes = await pool.query(
      `SELECT id, role, phone_number, phone_verified, onboarding_step
       FROM users WHERE id = $1`,
      [userId]
    );
    const user = userRes.rows[0];
    if (!user) {
      throw new Error('User not found');
    }

    const hasDriverRow = await pool.query(
      'SELECT phone_number, phone_verified FROM drivers WHERE user_id = $1',
      [userId]
    );
    const driver = hasDriverRow.rows[0];

    // A dual-role user who verified their phone on the DRIVER profile but not
    // the RIDER (users) row must still be considered phone-verified for the
    // rider app. Backfill the rider row so onboarding routing is consistent
    // and the user is taken straight into the main app instead of being
    // trapped on a phone-verify step that keeps auto-confirming.
    let riderPhoneVerified = !!user.phone_verified;
    const driverPhone = driver?.phone_number;
    const driverVerified = !!driver?.phone_verified;
    if (!riderPhoneVerified && driverVerified && driverPhone) {
      await pool.query(
        `UPDATE users SET phone_number = $1, is_verified = true, phone_verified = true WHERE id = $2`,
        [driverPhone, userId]
      );
      riderPhoneVerified = true;
    } else if (!driverVerified && riderPhoneVerified && user.phone_number) {
      // Dual-role user who verified their phone on the RIDER profile but never
      // triggered the driver-side phone flow (the driver app skips step 2 when
      // progress reports phone_verified from the users row). Backfill the
      // drivers row so the driver profile is treated as onboarding-complete
      // instead of bouncing the app back to onboarding forever.
      await pool.query(
        `UPDATE drivers SET phone_number = $1, phone_verified = true WHERE user_id = $2`,
        [user.phone_number, userId]
      );
    }

    const riderOnboardingComplete = riderPhoneVerified;

    const driverExists = !!driver;
    const driverPhoneVerified = driverVerified || riderPhoneVerified;
    // A dual-role user who verified the phone on the rider profile (users row)
    // but never on the driver profile must still be considered complete once
    // the driver onboarding steps are done — otherwise the driver app bounces
    // between MainWrapper and the onboarding screen indefinitely.
    const driverOnboardingComplete = driverExists && driverPhoneVerified;

    const roles: string[] = ['RIDER'];
    if (driverExists) roles.push('DRIVER');

    return {
      rider: {
        onboarding_complete: riderOnboardingComplete,
        phone_verified: riderPhoneVerified,
        phone_required: !user.phone_number && !riderPhoneVerified,
      },
      driver: {
        onboarding_complete: driverOnboardingComplete,
        phone_verified: driverPhoneVerified,
        exists: driverExists,
      },
      roles,
    };
  }

  static async requestEmailChange(userId: string, newEmail: string) {
    const userRes = await pool.query('SELECT full_name FROM users WHERE id = $1', [userId]);
    if (!userRes.rows[0]) throw new Error('User not found');

    const token = uuidv4();
    const data = JSON.stringify({ userId, newEmail });
    await redis.set(`email_change:${this.hashToken(token)}`, data, 'EX', 3600);

    await EmailService.sendEmailChangeLink(newEmail, userRes.rows[0].full_name, token);
    return { message: 'Verification link sent to your new email' };
  }

  static async verifyEmailChange(token: string) {
    const key = `email_change:${this.hashToken(token)}`;
    const dataStr = await redis.get(key);
    if (!dataStr) throw new Error('Invalid or expired verification link');

    const { userId, newEmail } = JSON.parse(dataStr);
    await pool.query('UPDATE users SET email = $1 WHERE id = $2', [newEmail, userId]);
    await redis.del(key);
    
    return { message: 'Email updated successfully' };
  }

  static async handleOAuth(data: {
    email: string;
    full_name: string;
    profile_image_url?: string | null;
    role: string;
    token?: string | null;
  }) {
    // Self-registration/OAuth may only resolve to RIDER or DRIVER.
    const role = assertPublicSignupRole(data.role);
    let email = data.email;

    // 1. The Supabase token is MANDATORY. Without it the client-supplied
    // email is unverified and could impersonate any existing account. There
    // is no fallback: fail closed.
    if (!data.token) {
      throw new Error('Authentication verification token is required');
    }
    try {
      if (!env.SUPABASE_URL) throw new Error('SUPABASE_URL not configured');

      // Sanitize URL to avoid double slashes
      const baseUrl = env.SUPABASE_URL.replace(/\/$/, '');
      const verifyUrl = `${baseUrl}/auth/v1/user`;

      // We call Supabase API directly to verify the token. 
      // This handles any algorithm (HS256, ES256, etc.) automatically.
      const response = await axios.get(verifyUrl, {
        headers: {
          'Authorization': `Bearer ${data.token}`,
          'apikey': env.SUPABASE_ANON_KEY,
        },
      });
      
      if (response.data && response.data.email) {
        email = response.data.email;
      } else {
        throw new Error('Invalid response from Supabase');
      }
    } catch (err: any) {
      const errorMsg = err.response?.data?.msg || err.message;
      console.error(`[AUTH] ❌ Supabase token verification failed:`, errorMsg);
      throw new Error(`Authentication verification failed: ${errorMsg}`);
    }

    // 2. Find the CONSUMER identity for this email (a colab account with the
    // same email is a separate identity and must not absorb the OAuth login).
    const existingRes = await pool.query(
      `SELECT * FROM users WHERE email = $1 AND role IN ('RIDER','DRIVER','ADMIN')`,
      [email],
    );
    let user = existingRes.rows[0];

    if (!user) {
      // 3. Create User - Default to UNVERIFIED (is_verified = false) even for
      // OAuth. The user row and its role-specific profile are committed
      // together so an interrupted insert can never leave a half-created
      // account that only a restart appears to fix.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const createRes = await client.query(
          `INSERT INTO users (email, full_name, profile_image_url, role, is_verified, is_active, password_changed_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           RETURNING *`,
          [email, data.full_name, data.profile_image_url, role, false, true]
        );
        user = createRes.rows[0];

        if (role === 'DRIVER') {
          await client.query(
            'INSERT INTO drivers (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
            [user.id],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      // Reactivate if deactivated
      if (!user.is_active) {
        await pool.query('UPDATE users SET is_active = true WHERE id = $1', [user.id]);
        user.is_active = true;
      }

      // Dual-role support: create a driver profile for the existing user
      // so they can complete driver onboarding without losing their rider
      // account. ON CONFLICT makes concurrent OAuth callbacks idempotent.
      if (role === 'DRIVER') {
        await pool.query(
          'INSERT INTO drivers (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
          [user.id],
        );
      }
    }

    const active = await this.resolveActiveRole(user.id, role);
    const token = this.generateToken(user, active.role);
    const phoneNumberRequired = !user.phone_number;
    const onboarding = await this.getOnboardingStatus(user.id);

    return { user: sanitizeUser(user), token, phone_number_required: phoneNumberRequired, onboarding };
  }

  static async requestOTP(email: string) {
    // Public endpoint: sends a LOGIN-purpose code but deliberately does NOT
    // create a login challenge — see verifyOTP below.
    await OTPService.generateOTP(email, 'LOGIN');
    return { message: 'Verification code sent to email' };
  }

  static async verifyOTP(data: {
    email: string;
    code: string;
    full_name?: string;
    role?: string;
  }) {
    const normalizedEmail = String(data.email ?? '').trim().toLowerCase();

    // Enforce the login-flow binding BEFORE the OTP is checked or consumed:
    // a code obtained through the public request-otp endpoint must never be
    // sufficient on its own to authenticate an existing password-protected
    // account. Administrators authenticate exclusively through the
    // password + admin 2FA flow.
    const preRes = await pool.query(
      `SELECT role, password_hash FROM users WHERE lower(email) = $1 AND role IN ('RIDER','DRIVER','ADMIN')`,
      [normalizedEmail],
    );
    const pre = preRes.rows[0];
    if (pre) {
      if (pre.role === UserRole.ADMIN) {
        throw new Error('Invalid or expired verification code');
      }
      if (pre.password_hash) {
        const challenge = await this.hasChallenge(this.loginChallengeKey(normalizedEmail));
        if (!challenge) {
          throw new Error('Invalid or expired verification code');
        }
      }
    }

    const isValid = await OTPService.verifyOTP(normalizedEmail, data.code, 'LOGIN');
    if (!isValid) {
      throw new Error('Invalid or expired verification code');
    }
    // Single-use: the challenge is consumed with the code.
    await this.clearChallenge(this.loginChallengeKey(normalizedEmail));

    // Find the CONSUMER identity for this email (colab accounts with the same
    // email are separate identities — never touched by consumer OTP flows).
    // Case-insensitive so a mixed-case stored address still resolves to the
    // same identity the normalized OTP was issued for.
    const existingRes = await pool.query(
      `SELECT * FROM users WHERE lower(email) = $1 AND role IN ('RIDER','DRIVER','ADMIN')`,
      [normalizedEmail],
    );
    let user = existingRes.rows[0];

    // Self-registration may only create RIDER/DRIVER accounts. For existing
    // accounts the role hint may only add a driver profile — it can never
    // rewrite users.role.
    const role = data.role != null ? assertPublicSignupRole(data.role) : null;

    if (!user) {
      if (!data.full_name || !role) {
        throw new Error('User not found. Please sign up.');
      }

      // Create User (Signup) - Default to UNVERIFIED. The role profile is
      // committed in the same transaction; a failure rolls the user back so
      // verification can never yield a user without its driver profile.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const createRes = await client.query(
          `INSERT INTO users (email, full_name, role, is_verified, is_active, password_changed_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           RETURNING *`,
          [data.email, data.full_name, role, false, true]
        );
        user = createRes.rows[0];

        if (role === 'DRIVER') {
          await client.query(
            'INSERT INTO drivers (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
            [user.id],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      // Reactivate if deactivated
      if (!user.is_active) {
        await pool.query('UPDATE users SET is_active = true WHERE id = $1', [user.id]);
        user.is_active = true;
      }

      // Dual-role support: create a driver profile for the existing user.
      // Idempotent under concurrent verification retries.
      if (role === 'DRIVER') {
        await pool.query(
          'INSERT INTO drivers (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
          [user.id],
        );
      }
    }

    const active = await this.resolveActiveRole(user.id, role);
    const token = this.generateToken(user, active.role);
    const phoneNumberRequired = !user.phone_number;
    const onboarding = await this.getOnboardingStatus(user.id);

    return { user: sanitizeUser(user), token, phone_number_required: phoneNumberRequired, onboarding };
  }

  static async requestPasswordChange(userId: string, currentPassword: string) {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    if (!user) throw new Error('User not found');
    if (!user.password_hash) throw new Error('OAuth accounts cannot change password');

    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) throw new Error('Current password incorrect');

    const token = uuidv4();
    await redis.set(`pwd_change_token:${this.hashToken(token)}`, userId, 'EX', 1800); // 30 mins

    await EmailService.sendPasswordChangeVerification(user.email, user.full_name, token);
    return { message: 'Verification email sent' };
  }

  static async verifyPasswordChangeToken(token: string) {
    const userId = await redis.get(`pwd_change_token:${this.hashToken(token)}`);
    if (!userId) throw new Error('Invalid or expired verification link');
    return { userId };
  }

  static async deleteAccount(userId: string) {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    return { message: 'Account deleted successfully' };
  }

  static async deactivateAccount(userId: string) {
    await pool.query('UPDATE users SET is_active = false WHERE id = $1', [userId]);
    return { message: 'Account deactivated successfully' };
  }

  static async requestAdmin2FA(email: string) {
    const normalized = String(email ?? '').trim().toLowerCase();
    const userRes = await pool.query(
      `SELECT role FROM users WHERE email = $1 AND role = 'ADMIN'`,
      [normalized],
    );
    const user = userRes.rows[0];
    if (!user || user.role !== UserRole.ADMIN) {
      // Generic response — never reveal whether an admin account exists.
      return { message: 'Verification code sent' };
    }

    // The endpoint is public; a code is only (re)sent while a password-verified
    // admin login is actually pending. Without a pending challenge this call
    // is a no-op so it can never be used to spam the admin inbox.
    const pending = await this.hasChallenge(this.adminChallengeKey(normalized));
    if (!pending) {
      return { message: 'Verification code sent' };
    }

    await OTPService.generateOTP(normalized, 'ADMIN_2FA', {
      deliverTo: env.ADMIN_NOTIFY_EMAIL || normalized,
    });
    return { message: 'Verification code sent' };
  }

  static async verifyAdmin2FA(email: string, code: string) {
    const normalized = String(email ?? '').trim().toLowerCase();

    // Only a pending, password-verified admin login may exchange a code for
    // a session.
    const pending = await this.hasChallenge(this.adminChallengeKey(normalized));
    if (!pending) {
      throw new Error('Invalid or expired verification code');
    }

    // The code is bound to THIS admin's identity (never a shared inbox key).
    const isValid = await OTPService.verifyOTP(normalized, code, 'ADMIN_2FA');
    if (!isValid) {
      throw new Error('Invalid or expired verification code');
    }
    await this.clearChallenge(this.adminChallengeKey(normalized));

    const userRes = await pool.query(
      `SELECT * FROM users WHERE email = $1 AND role = 'ADMIN'`,
      [normalized],
    );
    const user = userRes.rows[0];
    if (!user || user.role !== UserRole.ADMIN) {
      throw new Error('Unauthorized');
    }

    const token = this.generateToken(user);
    const trustedDeviceToken = this.generateTrustedDeviceToken(user);
    return { user: sanitizeUser(user), token, trustedDeviceToken };
  }

  /**
   * A dedicated "remember this device" token — valid for 30 days. While it is
   * unexpired the admin skips the emailed 2FA code on login; after 30 days it
   * fails verification and the code is required again.
   */
  static generateTrustedDeviceToken(user: any): string {
    return jwt.sign(
      { id: user.id, role: user.role, email: user.email, t: 'trusted-device' },
      env.JWT_SECRET,
      { expiresIn: '30d', algorithm: 'HS256' },
    );
  }

  static generateToken(user: any, roleOverride?: string): string {
    // The `role` claim MUST reflect the active application session, not the
    // frozen `users.role` column. For dual-role users (same email owning both
    // a Rider and a Driver profile), the active role is decided by the
    // application that initiated the session, not by which profile was
    // created first. `roleOverride` is the authoritative active role derived
    // via resolveActiveRole() from the client's app context.
    const role = roleOverride ?? user.role;
    return jwt.sign(
      { id: user.id, role, email: user.email, t: 'access' },
      env.JWT_SECRET,
      { expiresIn: '30d', algorithm: 'HS256' }
    );
  }

  /**
   * Resolve the ACTIVE session role from the connecting application's context.
   *
   * A single authenticated identity may own both a Rider profile (the `users`
   * row) and a Driver profile (the `drivers` row). The backend must never
   * guess the active role from `users.role` alone — it must use the explicit
   * application context supplied by the client (`appRoleHint`, e.g. "DRIVER"
   * from the Driver App, "RIDER" from the Rider App), and only honor it when
   * the user actually holds that profile.
   *
   * Returns the resolved role plus the resolved profile ids so downstream
   * realtime/presence/matching logic always operates on the correct profile.
   */
  static async resolveActiveRole(
    userId: string,
    appRoleHint?: string | null,
  ): Promise<{ role: string; driverId: string | null; riderId: string | null }> {
    // If the user's database role is ADMIN, always resolve as ADMIN
    // regardless of the app hint. The hint-based logic below is for
    // dual-role (RIDER + DRIVER) users only.
    const userRes = await pool.query(
      'SELECT role FROM users WHERE id = $1',
      [userId]
    );
    const dbRole = userRes.rows[0]?.role ?? null;

    // A non-admin can never obtain an ADMIN session. ADMIN comes exclusively
    // from the authoritative users.role column — never from a client hint.
    if (dbRole === UserRole.ADMIN) {
      return { role: 'ADMIN', driverId: null, riderId: userId };
    }

    const driverRes = await pool.query(
      'SELECT 1 FROM drivers WHERE user_id = $1',
      [userId]
    );
    const hasDriverProfile = driverRes.rows.length > 0;

    // Rider profile is the users row itself; it always exists for an
    // authenticated user.
    const riderId = userId;
    const driverId = hasDriverProfile ? userId : null;
    const role = resolveSessionRole(dbRole, hasDriverProfile, appRoleHint);

    return { role, driverId, riderId };
  }

  static verifyToken(token: string): any {
    return jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
  }

  /**
   * Server-side revocation check for an already signature-verified access
   * token. A JWT is valid for up to 30 days, so the claims alone must not be
   * trusted: the subject is re-read from the database on every authenticated
   * request.
   *
   *  - the user must still exist and be active (deactivation);
   *  - a token carrying the ADMIN role must still belong to a user whose
   *    stored role is ADMIN (demotion);
   *  - a token issued before the account's last password change is rejected
   *    (password change/reset invalidates every older session).
   *
   * Throws on any failure; resolves with no value when the token is current.
   */
  static async assertTokenStillValid(decoded: any): Promise<void> {
    if (!decoded || typeof decoded.id !== 'string' || !decoded.id) {
      throw new Error('Invalid token subject');
    }
    const res = await pool.query(
      'SELECT role, is_active, password_changed_at FROM users WHERE id = $1',
      [decoded.id],
    );
    const row = res.rows[0];
    if (!row) throw new Error('Token subject no longer exists');
    if (row.is_active === false) throw new Error('Account is deactivated');

    if (decoded.role === UserRole.ADMIN && row.role !== UserRole.ADMIN) {
      throw new Error('Administrator role revoked');
    }

    if (row.password_changed_at) {
      const changedAtSec = Math.floor(new Date(row.password_changed_at).getTime() / 1000);
      const iat = Number(decoded.iat);
      // One second of tolerance absorbs sub-second skew between the DB clock
      // (password_changed_at) and JWT issue time for a session created in the
      // same instant as a password change.
      if (!Number.isFinite(iat) || iat + 1 < changedAtSec) {
        throw new Error('Token issued before last password change');
      }
    }
  }
}
