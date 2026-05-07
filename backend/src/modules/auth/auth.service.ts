// backend/src/modules/auth/auth.service.ts
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../../config/env';
import { pool } from '../../config/database';
import { redis } from '../../config/redis';
import { EmailService } from '../../services/email.service';
import { OTPService } from './otp.service';
import { UserRole } from '../../types';

export class AuthService {
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
      `INSERT INTO users (email, full_name, password_hash, role, is_verified, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
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

  static async loginWithPassword(data: { email: string; password?: string }) {
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

    const token = this.generateToken(user);
    const phoneNumberRequired = !user.phone_number;
    return { user, token, phone_number_required: phoneNumberRequired };
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
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, userId]);
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
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, userId]);
    await redis.del(`reset_token:${token}`);
    return { message: 'Password reset successfully' };
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
    profile_image_url?: string;
    role: string;
    token?: string;
  }) {
    let email = data.email;

    // 1. Verify Supabase Token if provided (Mandatory for security)
    if (data.token) {
      try {
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
        `INSERT INTO users (email, full_name, profile_image_url, role, is_verified, is_active)
         VALUES ($1, $2, $3, $4, $5, $6)
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
    }

    const token = this.generateToken(user);
    const phoneNumberRequired = !user.phone_number;
    
    return { user, token, phone_number_required: phoneNumberRequired };
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
        `INSERT INTO users (email, full_name, role, is_verified, is_active)
         VALUES ($1, $2, $3, $4, $5)
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
    }

    const token = this.generateToken(user);
    const phoneNumberRequired = !user.phone_number;
    
    return { user, token, phone_number_required: phoneNumberRequired };
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

  static generateToken(user: any): string {
    return jwt.sign(
      { id: user.id, role: user.role, email: user.email },
      env.JWT_SECRET,
      { expiresIn: '30d', algorithm: 'HS256' }
    );
  }

  static verifyToken(token: string): any {
    return jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
  }
}
