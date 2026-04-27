// backend/src/modules/auth/auth.service.ts
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../../config/env';
import { pool } from '../../config/database';
import { OTPService } from './otp.service';
import { UserRepository } from '../user/user.repository';
import { redis } from '../../config/redis';
import { EmailService } from '../../services/email.service';

export class AuthService {
  static async signupWithPassword(data: {
    email: string;
    full_name: string;
    password?: string;
    role: string;
  }) {
    const existingRes = await pool.query('SELECT * FROM users WHERE email = $1', [data.email]);
    if (existingRes.rows[0]) {
      throw new Error('User already exists');
    }

    let passwordHash = undefined;
    if (data.password) {
      passwordHash = await bcrypt.hash(data.password, 10);
    }

    const user = await UserRepository.create({
      email: data.email,
      full_name: data.full_name,
      password_hash: passwordHash,
      role: data.role as any,
    });

    if (data.role === 'DRIVER') {
      await pool.query('INSERT INTO drivers (user_id) VALUES ($1)', [user.id]);
    }

    const token = this.generateToken(user);
    return { user, token };
  }

  static async loginWithPassword(data: {
    email: string;
    password?: string;
  }) {
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

    const token = this.generateToken(user);
    return { user, token };
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
  }) {
    // 1. Find User
    const existingRes = await pool.query('SELECT * FROM users WHERE email = $1', [data.email]);
    let user = existingRes.rows[0];

    if (!user) {
      // 2. Create User
      const createRes = await pool.query(
        `INSERT INTO users (email, full_name, profile_image_url, role, is_verified)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [data.email, data.full_name, data.profile_image_url, data.role, true]
      );
      user = createRes.rows[0];

      if (data.role === 'DRIVER') {
        await pool.query('INSERT INTO drivers (user_id) VALUES ($1)', [user.id]);
      }
    }

    const token = this.generateToken(user);
    return { user, token };
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

      // Create User (Signup)
      const createRes = await pool.query(
        `INSERT INTO users (email, full_name, role, is_verified)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [data.email, data.full_name, data.role, true]
      );
      user = createRes.rows[0];

      if (data.role === 'DRIVER') {
        await pool.query('INSERT INTO drivers (user_id) VALUES ($1)', [user.id]);
      }
    }

    const token = this.generateToken(user);
    return { user, token };
  }

  static generateToken(user: any): string {
    return jwt.sign(
      { id: user.id, role: user.role, email: user.email },
      env.JWT_SECRET,
      { expiresIn: '30d' }
    );
  }

  static verifyToken(token: string): any {
    return jwt.verify(token, env.JWT_SECRET);
  }
}
