"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
// backend/src/modules/auth/auth.service.ts
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const uuid_1 = require("uuid");
const env_1 = require("../../config/env");
const database_1 = require("../../config/database");
const redis_1 = require("../../config/redis");
const email_service_1 = require("../../services/email.service");
const otp_service_1 = require("./otp.service");
const types_1 = require("../../types");
class AuthService {
    static async signupWithPassword(data) {
        const existingRes = await database_1.pool.query('SELECT id FROM users WHERE email = $1', [data.email]);
        if (existingRes.rows.length > 0) {
            throw new Error('User already exists');
        }
        const passwordHash = await bcryptjs_1.default.hash(data.password, 10);
        const createRes = await database_1.pool.query(`INSERT INTO users (email, full_name, password_hash, role, is_verified, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`, [data.email, data.full_name, passwordHash, data.role, false, true]);
        const user = createRes.rows[0];
        if (data.role === types_1.UserRole.DRIVER) {
            await database_1.pool.query('INSERT INTO drivers (user_id) VALUES ($1)', [user.id]);
        }
        await otp_service_1.OTPService.generateOTP(data.email);
        return { otp_required: true, message: 'Verification code sent to email' };
    }
    static async loginWithPassword(data) {
        const userRes = await database_1.pool.query('SELECT * FROM users WHERE email = $1', [data.email]);
        const user = userRes.rows[0];
        if (!user) {
            throw new Error('User not found');
        }
        if (!user.password_hash) {
            throw new Error('This account uses a different login method');
        }
        if (data.password) {
            const isValid = await bcryptjs_1.default.compare(data.password, user.password_hash);
            if (!isValid) {
                throw new Error('Invalid password');
            }
        }
        else {
            throw new Error('Password is required');
        }
        if (!user.is_active) {
            await database_1.pool.query('UPDATE users SET is_active = true WHERE id = $1', [user.id]);
            user.is_active = true;
        }
        const token = this.generateToken(user);
        return { user, token };
    }
    static async changePassword(userId, data) {
        const userRes = await database_1.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];
        if (!user)
            throw new Error('User not found');
        if (data.currentPassword) {
            if (!user.password_hash)
                throw new Error('Password not set for this account');
            const isValid = await bcryptjs_1.default.compare(data.currentPassword, user.password_hash);
            if (!isValid)
                throw new Error('Current password incorrect');
        }
        const newHash = await bcryptjs_1.default.hash(data.newPassword, 10);
        await database_1.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, userId]);
        return { message: 'Password updated successfully' };
    }
    static async forgotPassword(email) {
        const userRes = await database_1.pool.query('SELECT id, full_name FROM users WHERE email = $1', [email]);
        const user = userRes.rows[0];
        if (!user)
            throw new Error('If an account exists with this email, you will receive a reset link');
        const token = (0, uuid_1.v4)();
        await redis_1.redis.set(`reset_token:${token}`, user.id, 'EX', 3600); // 1 hour
        await email_service_1.EmailService.sendPasswordResetLink(email, user.full_name, token);
        return { message: 'Password reset link sent to email' };
    }
    static async resetPassword(token, newPassword) {
        const userId = await redis_1.redis.get(`reset_token:${token}`);
        if (!userId)
            throw new Error('Invalid or expired reset token');
        const newHash = await bcryptjs_1.default.hash(newPassword, 10);
        await database_1.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, userId]);
        await redis_1.redis.del(`reset_token:${token}`);
        return { message: 'Password reset successfully' };
    }
    static async requestEmailChange(userId, newEmail) {
        const userRes = await database_1.pool.query('SELECT full_name FROM users WHERE id = $1', [userId]);
        if (!userRes.rows[0])
            throw new Error('User not found');
        const token = (0, uuid_1.v4)();
        const data = JSON.stringify({ userId, newEmail });
        await redis_1.redis.set(`email_change:${token}`, data, 'EX', 3600);
        await email_service_1.EmailService.sendEmailChangeLink(newEmail, userRes.rows[0].full_name, token);
        return { message: 'Verification link sent to your new email' };
    }
    static async verifyEmailChange(token) {
        const dataStr = await redis_1.redis.get(`email_change:${token}`);
        if (!dataStr)
            throw new Error('Invalid or expired verification link');
        const { userId, newEmail } = JSON.parse(dataStr);
        await database_1.pool.query('UPDATE users SET email = $1 WHERE id = $2', [newEmail, userId]);
        await redis_1.redis.del(`email_change:${token}`);
        return { message: 'Email updated successfully' };
    }
    static async handleOAuth(data) {
        // 1. Find User
        const existingRes = await database_1.pool.query('SELECT * FROM users WHERE email = $1', [data.email]);
        let user = existingRes.rows[0];
        if (!user) {
            // 2. Create User - Default to NOT verified
            const createRes = await database_1.pool.query(`INSERT INTO users (email, full_name, profile_image_url, role, is_verified, is_active)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`, [data.email, data.full_name, data.profile_image_url, data.role, false, true]);
            user = createRes.rows[0];
            if (data.role === 'DRIVER') {
                await database_1.pool.query('INSERT INTO drivers (user_id) VALUES ($1)', [user.id]);
            }
        }
        else {
            // Reactivate if deactivated
            if (!user.is_active) {
                await database_1.pool.query('UPDATE users SET is_active = true WHERE id = $1', [user.id]);
                user.is_active = true;
            }
        }
        const token = this.generateToken(user);
        return { user, token };
    }
    static async requestOTP(email) {
        await otp_service_1.OTPService.generateOTP(email);
        return { message: 'Verification code sent to email' };
    }
    static async verifyOTP(data) {
        const isValid = await otp_service_1.OTPService.verifyOTP(data.email, data.code);
        if (!isValid) {
            throw new Error('Invalid or expired verification code');
        }
        // Find User
        const existingRes = await database_1.pool.query('SELECT * FROM users WHERE email = $1', [data.email]);
        let user = existingRes.rows[0];
        if (!user) {
            if (!data.full_name || !data.role) {
                throw new Error('User not found. Please sign up.');
            }
            // Create User (Signup)
            const createRes = await database_1.pool.query(`INSERT INTO users (email, full_name, role, is_verified, is_active)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`, [data.email, data.full_name, data.role, true, true]);
            user = createRes.rows[0];
            if (data.role === 'DRIVER') {
                await database_1.pool.query('INSERT INTO drivers (user_id) VALUES ($1)', [user.id]);
            }
        }
        else {
            // Reactivate if deactivated
            if (!user.is_active) {
                await database_1.pool.query('UPDATE users SET is_active = true WHERE id = $1', [user.id]);
                user.is_active = true;
            }
        }
        const token = this.generateToken(user);
        return { user, token };
    }
    static async requestPasswordChange(userId, currentPassword) {
        const userRes = await database_1.pool.query('SELECT * FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];
        if (!user)
            throw new Error('User not found');
        if (!user.password_hash)
            throw new Error('OAuth accounts cannot change password');
        const isValid = await bcryptjs_1.default.compare(currentPassword, user.password_hash);
        if (!isValid)
            throw new Error('Current password incorrect');
        const token = (0, uuid_1.v4)();
        await redis_1.redis.set(`pwd_change_token:${token}`, userId, 'EX', 1800); // 30 mins
        await email_service_1.EmailService.sendPasswordChangeVerification(user.email, user.full_name, token);
        return { message: 'Verification email sent' };
    }
    static async verifyPasswordChangeToken(token) {
        const userId = await redis_1.redis.get(`pwd_change_token:${token}`);
        if (!userId)
            throw new Error('Invalid or expired verification link');
        return { userId };
    }
    static async deleteAccount(userId) {
        await database_1.pool.query('DELETE FROM users WHERE id = $1', [userId]);
        return { message: 'Account deleted successfully' };
    }
    static async deactivateAccount(userId) {
        await database_1.pool.query('UPDATE users SET is_active = false WHERE id = $1', [userId]);
        return { message: 'Account deactivated successfully' };
    }
    static generateToken(user) {
        return jsonwebtoken_1.default.sign({ id: user.id, role: user.role, email: user.email }, env_1.env.JWT_SECRET, { expiresIn: '30d' });
    }
    static verifyToken(token) {
        return jsonwebtoken_1.default.verify(token, env_1.env.JWT_SECRET);
    }
}
exports.AuthService = AuthService;
//# sourceMappingURL=auth.service.js.map