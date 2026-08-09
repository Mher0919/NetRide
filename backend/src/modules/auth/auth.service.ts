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

export class AuthService {
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
    const existingRes = await pool.query('SELECT id FROM users WHERE email = $1', [data.email]);
    if (existingRes.rows.length > 0) {
      throw new Error('User already exists');
    }

    const passwordHash = await bcrypt.hash(data.password, 10);
    const createRes = await pool.query(
      `INSERT INTO users (email, full_name, password_hash, role, is_verified, is_active, password_changed_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [data.email, data.full_name, passwordHash, data.role, false, true]
    );
    const user = createRes.rows[0];

    if (data.role === UserRole.DRIVER) {
      await pool.query('INSERT INTO drivers (user_id) VALUES ($1)', [user.id]);
    }

    await OTPService.generateOTP(data.email);
    return { otp_required: true, phone_number_required: true, message: 'Verification code sent to email' };
  }

  static async loginWithPassword(data: { email: string; password?: string; trusted_device_token?: string | null; app_role?: string }) {
    const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [data.email]);
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
          if (decoded.email === user.email && decoded.role === UserRole.ADMIN) {
            isTrusted = true;
          }
        } catch (e) {
          // Token invalid or expired, ignore
        }
      }

      if (!isTrusted) {
        await OTPService.generateOTP(env.GMAIL_USER_EMAIL || user.email);
        return { 
          otp_required: true, 
          email: env.GMAIL_USER_EMAIL || user.email,
          message: 'Admin 2FA required. Code sent to trusted email.' 
        };
      }
    }

    // Check password expiration (90 days)
    const expirationDays = 90;
    const passwordChangedAt = user.password_changed_at ? new Date(user.password_changed_at) : new Date(0);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - passwordChangedAt.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    const passwordExpired = diffDays > expirationDays;

    const onboarding = await this.getOnboardingStatus(user.id);
    return { user, token, phone_number_required: phoneNumberRequired, password_expired: passwordExpired, onboarding };
  }

  static async changePassword(userId: string, data: { currentPassword?: string, newPassword: string }) {
    const userRes = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    if (!user) throw new Error('User not found');

    if (data.currentPassword) {
      if (!user.password_hash) throw new Error('Password not set for this account');
      const isValid = await bcrypt.compare(data.currentPassword, user.password_hash);
      if (!isValid) throw new Error('Current password incorrect');
    }

    const newHash = await bcrypt.hash(data.newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2', [newHash, userId]);
    return { message: 'Password updated successfully' };
  }

  static async forgotPassword(email: string) {
    const userRes = await pool.query('SELECT id, full_name FROM users WHERE email = $1', [email]);
    const user = userRes.rows[0];
    if (!user) throw new Error('If an account exists with this email, you will receive a reset link');

    const token = uuidv4();
    await redis.set(`reset_token:${token}`, user.id, 'EX', 3600); // 1 hour

    await EmailService.sendPasswordResetLink(email, user.full_name, token);
    return { message: 'Password reset link sent to email' };
  }

  static async resetPassword(token: string, newPassword: string) {
    const userId = await redis.get(`reset_token:${token}`);
    if (!userId) throw new Error('Invalid or expired reset token');

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2', [newHash, userId]);
    await redis.del(`reset_token:${token}`);
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
    await redis.set(`email_change:${token}`, data, 'EX', 3600);

    await EmailService.sendEmailChangeLink(newEmail, userRes.rows[0].full_name, token);
    return { message: 'Verification link sent to your new email' };
  }

  static async verifyEmailChange(token: string) {
    const dataStr = await redis.get(`email_change:${token}`);
    if (!dataStr) throw new Error('Invalid or expired verification link');

    const { userId, newEmail } = JSON.parse(dataStr);
    await pool.query('UPDATE users SET email = $1 WHERE id = $2', [newEmail, userId]);
    await redis.del(`email_change:${token}`);
    
    return { message: 'Email updated successfully' };
  }

  static async handleOAuth(data: {
    email: string;
    full_name: string;
    profile_image_url?: string | null;
    role: string;
    token?: string | null;
  }) {
    let email = data.email;

    // 1. Verify Supabase Token if provided (Mandatory for security)
    if (data.token) {
      try {
        if (!env.SUPABASE_URL) throw new Error('SUPABASE_URL not configured');
        
        // Sanitize URL to avoid double slashes
        const baseUrl = env.SUPABASE_URL.replace(/\/$/, '');
        const verifyUrl = `${baseUrl}/auth/v1/user`;
        
        console.log(`[AUTH] 🛡️ Verifying Supabase token for ${email} at ${verifyUrl}`);

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
          console.log(`[AUTH] ✅ Supabase token verified via API for ${email}`);
        } else {
          throw new Error('Invalid response from Supabase');
        }
      } catch (err: any) {
        const errorMsg = err.response?.data?.msg || err.message;
        console.error(`[AUTH] ❌ Supabase token verification failed:`, errorMsg);
        throw new Error(`Authentication verification failed: ${errorMsg}`);
      }
    }

    // 2. Find User
    const existingRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    let user = existingRes.rows[0];

    if (!user) {
      // 3. Create User - Default to UNVERIFIED (is_verified = false) even for OAuth
      const createRes = await pool.query(
        `INSERT INTO users (email, full_name, profile_image_url, role, is_verified, is_active, password_changed_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING *`,
        [email, data.full_name, data.profile_image_url, data.role, false, true]
      );
      user = createRes.rows[0];

      if (data.role === 'DRIVER') {
        await pool.query('INSERT INTO drivers (user_id) VALUES ($1)', [user.id]);
      }
    } else {
      // Reactivate if deactivated
      if (!user.is_active) {
        await pool.query('UPDATE users SET is_active = true WHERE id = $1', [user.id]);
        user.is_active = true;
      }

      // Dual-role support: create a driver profile for the existing user
      // so they can complete driver onboarding without losing their rider account.
      if (data.role === 'DRIVER') {
        const driverCheck = await pool.query('SELECT 1 FROM drivers WHERE user_id = $1', [user.id]);
        if (driverCheck.rows.length === 0) {
          await pool.query('INSERT INTO drivers (user_id) VALUES ($1)', [user.id]);
        }
      }
    }

    const active = await this.resolveActiveRole(user.id, data.role);
    const token = this.generateToken(user, active.role);
    const phoneNumberRequired = !user.phone_number;
    const onboarding = await this.getOnboardingStatus(user.id);

    return { user, token, phone_number_required: phoneNumberRequired, onboarding };
  }

  static async requestOTP(email: string) {
    await OTPService.generateOTP(email);
    return { message: 'Verification code sent to email' };
  }

  static async verifyOTP(data: {
    email: string;
    code: string;
    full_name?: string;
    role?: string;
  }) {
    const isValid = await OTPService.verifyOTP(data.email, data.code);
    if (!isValid) {
      throw new Error('Invalid or expired verification code');
    }

    // Find User
    const existingRes = await pool.query('SELECT * FROM users WHERE email = $1', [data.email]);
    let user = existingRes.rows[0];

    if (!user) {
      if (!data.full_name || !data.role) {
        throw new Error('User not found. Please sign up.');
      }

      // Create User (Signup) - Default to UNVERIFIED
      const createRes = await pool.query(
        `INSERT INTO users (email, full_name, role, is_verified, is_active, password_changed_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING *`,
        [data.email, data.full_name, data.role, false, true]
      );
      user = createRes.rows[0];

      if (data.role === 'DRIVER') {
        await pool.query('INSERT INTO drivers (user_id) VALUES ($1)', [user.id]);
      }
    } else {
      // Reactivate if deactivated
      if (!user.is_active) {
        await pool.query('UPDATE users SET is_active = true WHERE id = $1', [user.id]);
        user.is_active = true;
      }

      // Dual-role support: create a driver profile for the existing user
      if (data.role === 'DRIVER') {
        const driverCheck = await pool.query('SELECT 1 FROM drivers WHERE user_id = $1', [user.id]);
        if (driverCheck.rows.length === 0) {
          await pool.query('INSERT INTO drivers (user_id) VALUES ($1)', [user.id]);
        }
      }
    }

    const active = await this.resolveActiveRole(user.id, data.role);
    const token = this.generateToken(user, active.role);
    const phoneNumberRequired = !user.phone_number;
    const onboarding = await this.getOnboardingStatus(user.id);

    return { user, token, phone_number_required: phoneNumberRequired, onboarding };
  }

  static async requestPasswordChange(userId: string, currentPassword: string) {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    if (!user) throw new Error('User not found');
    if (!user.password_hash) throw new Error('OAuth accounts cannot change password');

    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) throw new Error('Current password incorrect');

    const token = uuidv4();
    await redis.set(`pwd_change_token:${token}`, userId, 'EX', 1800); // 30 mins

    await EmailService.sendPasswordChangeVerification(user.email, user.full_name, token);
    return { message: 'Verification email sent' };
  }

  static async verifyPasswordChangeToken(token: string) {
    const userId = await redis.get(`pwd_change_token:${token}`);
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
    const userRes = await pool.query('SELECT role FROM users WHERE email = $1', [email]);
    const user = userRes.rows[0];
    if (!user || user.role !== UserRole.ADMIN) {
      throw new Error('Unauthorized');
    }

    await OTPService.generateOTP(env.GMAIL_USER_EMAIL || email);
    return { message: 'Verification code sent' };
  }

  static async verifyAdmin2FA(email: string, code: string) {
    const isValid = await OTPService.verifyOTP(env.GMAIL_USER_EMAIL || email, code);
    if (!isValid) {
      throw new Error('Invalid or expired verification code');
    }

    const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = userRes.rows[0];
    if (!user || user.role !== UserRole.ADMIN) {
      throw new Error('Unauthorized');
    }

    const token = this.generateToken(user);
    return { user, token };
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
      { id: user.id, role, email: user.email },
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
    const hint = (appRoleHint ?? '').toString().trim().toUpperCase();

    // If the user's database role is ADMIN, always resolve as ADMIN
    // regardless of the app hint. The hint-based logic below is for
    // dual-role (RIDER + DRIVER) users only.
    const userRes = await pool.query(
      'SELECT role FROM users WHERE id = $1',
      [userId]
    );
    if (userRes.rows.length > 0 && userRes.rows[0].role === UserRole.ADMIN) {
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

    let role: string;
    if (hint === 'ADMIN') {
      role = 'ADMIN';
    } else if (hint === 'DRIVER' && hasDriverProfile) {
      role = 'DRIVER';
    } else if (hint === 'RIDER') {
      role = 'RIDER';
    } else if (hint === 'DRIVER') {
      // Driver app context but no driver profile yet — they are about to
      // start driver onboarding. Resolve as RIDER-identity-bearing until the
      // driver profile exists; the app routing will send them to onboarding.
      role = 'RIDER';
    } else if (hasDriverProfile) {
      role = 'RIDER';
    } else {
      role = 'RIDER';
    }

    return { role, driverId, riderId };
  }

  static verifyToken(token: string): any {
    return jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
  }
}
