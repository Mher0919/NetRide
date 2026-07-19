"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
// backend/src/modules/auth/auth.service.ts
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const axios_1 = __importDefault(require("axios"));
const uuid_1 = require("uuid");
const env_1 = require("../../config/env");
const database_1 = require("../../config/database");
const redis_1 = require("../../config/redis");
const email_service_1 = require("../../services/email.service");
const sms_service_1 = require("../../services/sms.service");
const otp_service_1 = require("./otp.service");
const types_1 = require("../../types");
class AuthService {
    static async requestPhoneOTP(userId, phoneNumber, role) {
        // 1. Check if this phone is already verified for the SAME user
        //    (either on their rider profile via users table, or driver profile via drivers table)
        const userRes = await database_1.pool.query(`SELECT phone_number, phone_verified FROM users WHERE id = $1`, [userId]);
        if (userRes.rows[0]?.phone_number === phoneNumber && userRes.rows[0]?.phone_verified) {
            // Same user, same phone, already verified on rider side → auto-verify for driver
            if (role === 'DRIVER') {
                await database_1.pool.query(`UPDATE drivers SET phone_number = $1, phone_verified = true WHERE user_id = $2`, [phoneNumber, userId]);
            }
            return { auto_verified: true, message: 'Phone already verified on your account.' };
        }
        const driverRes = await database_1.pool.query(`SELECT phone_number, phone_verified FROM drivers WHERE user_id = $1`, [userId]);
        if (driverRes.rows[0]?.phone_number === phoneNumber && driverRes.rows[0]?.phone_verified) {
            return { auto_verified: true, message: 'Phone already verified on your account.' };
        }
        // 2. Check if phone belongs to a DIFFERENT user
        const otherUser = await database_1.pool.query('SELECT id FROM users WHERE phone_number = $1 AND id != $2', [phoneNumber, userId]);
        if (otherUser.rows.length > 0) {
            throw new Error('This phone number is already associated with another account');
        }
        const otherDriver = await database_1.pool.query('SELECT user_id FROM drivers WHERE phone_number = $1 AND user_id != $2', [phoneNumber, userId]);
        if (otherDriver.rows.length > 0) {
            throw new Error('This phone number is already associated with another account');
        }
        // 3. Normal Twilio flow
        return sms_service_1.SmsService.sendVerificationCode(phoneNumber);
    }
    static async verifyPhoneOTP(userId, phoneNumber, code, role) {
        const result = await sms_service_1.SmsService.verifyCode(phoneNumber, code);
        if (result.status === 'approved') {
            if (role === 'DRIVER') {
                // Ensure drivers row exists (dual-role safety)
                const exists = await database_1.pool.query('SELECT 1 FROM drivers WHERE user_id = $1', [userId]);
                if (exists.rows.length === 0) {
                    await database_1.pool.query('INSERT INTO drivers (user_id) VALUES ($1)', [userId]);
                }
                await database_1.pool.query(`UPDATE drivers SET phone_number = $1, phone_verified = true WHERE user_id = $2`, [phoneNumber, userId]);
            }
            else {
                await database_1.pool.query('UPDATE users SET phone_number = $1, is_verified = true, phone_verified = true WHERE id = $2', [phoneNumber, userId]);
            }
            return { success: true, message: 'Phone number verified' };
        }
        throw new Error('Invalid or expired verification code');
    }
    static async signupWithPassword(data) {
        const existingRes = await database_1.pool.query('SELECT id FROM users WHERE email = $1', [data.email]);
        if (existingRes.rows.length > 0) {
            throw new Error('User already exists');
        }
        const passwordHash = await bcryptjs_1.default.hash(data.password, 10);
        const createRes = await database_1.pool.query(`INSERT INTO users (email, full_name, password_hash, role, is_verified, is_active, password_changed_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`, [data.email, data.full_name, passwordHash, data.role, false, true]);
        const user = createRes.rows[0];
        if (data.role === types_1.UserRole.DRIVER) {
            await database_1.pool.query('INSERT INTO drivers (user_id) VALUES ($1)', [user.id]);
        }
        await otp_service_1.OTPService.generateOTP(data.email);
        return { otp_required: true, phone_number_required: true, message: 'Verification code sent to email' };
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
        const phoneNumberRequired = !user.phone_number;
        // ADMIN 2FA Check
        if (user.role === types_1.UserRole.ADMIN) {
            // Check if device is trusted
            let isTrusted = false;
            if (data.trusted_device_token) {
                try {
                    const decoded = this.verifyToken(data.trusted_device_token);
                    if (decoded.email === user.email && decoded.role === types_1.UserRole.ADMIN) {
                        isTrusted = true;
                    }
                }
                catch (e) {
                    // Token invalid or expired, ignore
                }
            }
            if (!isTrusted) {
                await otp_service_1.OTPService.generateOTP(env_1.env.GMAIL_USER_EMAIL || user.email);
                return {
                    otp_required: true,
                    email: env_1.env.GMAIL_USER_EMAIL || user.email,
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
        return { user, token, phone_number_required: phoneNumberRequired, password_expired: passwordExpired };
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
        await database_1.pool.query('UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2', [newHash, userId]);
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
        await database_1.pool.query('UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2', [newHash, userId]);
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
        let email = data.email;
        // 1. Verify Supabase Token if provided (Mandatory for security)
        if (data.token) {
            try {
                if (!env_1.env.SUPABASE_URL)
                    throw new Error('SUPABASE_URL not configured');
                // Sanitize URL to avoid double slashes
                const baseUrl = env_1.env.SUPABASE_URL.replace(/\/$/, '');
                const verifyUrl = `${baseUrl}/auth/v1/user`;
                console.log(`[AUTH] 🛡️ Verifying Supabase token for ${email} at ${verifyUrl}`);
                // We call Supabase API directly to verify the token. 
                // This handles any algorithm (HS256, ES256, etc.) automatically.
                const response = await axios_1.default.get(verifyUrl, {
                    headers: {
                        'Authorization': `Bearer ${data.token}`,
                        'apikey': env_1.env.SUPABASE_ANON_KEY,
                    },
                });
                if (response.data && response.data.email) {
                    email = response.data.email;
                    console.log(`[AUTH] ✅ Supabase token verified via API for ${email}`);
                }
                else {
                    throw new Error('Invalid response from Supabase');
                }
            }
            catch (err) {
                const errorMsg = err.response?.data?.msg || err.message;
                console.error(`[AUTH] ❌ Supabase token verification failed:`, errorMsg);
                throw new Error(`Authentication verification failed: ${errorMsg}`);
            }
        }
        // 2. Find User
        const existingRes = await database_1.pool.query('SELECT * FROM users WHERE email = $1', [email]);
        let user = existingRes.rows[0];
        if (!user) {
            // 3. Create User - Default to UNVERIFIED (is_verified = false) even for OAuth
            const createRes = await database_1.pool.query(`INSERT INTO users (email, full_name, profile_image_url, role, is_verified, is_active, password_changed_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING *`, [email, data.full_name, data.profile_image_url, data.role, false, true]);
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
            // Dual-role support: create a driver profile for the existing user
            // so they can complete driver onboarding without losing their rider account.
            if (data.role === 'DRIVER') {
                const driverCheck = await database_1.pool.query('SELECT 1 FROM drivers WHERE user_id = $1', [user.id]);
                if (driverCheck.rows.length === 0) {
                    await database_1.pool.query('INSERT INTO drivers (user_id) VALUES ($1)', [user.id]);
                }
            }
        }
        const token = this.generateToken(user);
        const phoneNumberRequired = !user.phone_number;
        return { user, token, phone_number_required: phoneNumberRequired };
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
            // Create User (Signup) - Default to UNVERIFIED
            const createRes = await database_1.pool.query(`INSERT INTO users (email, full_name, role, is_verified, is_active, password_changed_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING *`, [data.email, data.full_name, data.role, false, true]);
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
            // Dual-role support: create a driver profile for the existing user
            if (data.role === 'DRIVER') {
                const driverCheck = await database_1.pool.query('SELECT 1 FROM drivers WHERE user_id = $1', [user.id]);
                if (driverCheck.rows.length === 0) {
                    await database_1.pool.query('INSERT INTO drivers (user_id) VALUES ($1)', [user.id]);
                }
            }
        }
        const token = this.generateToken(user);
        const phoneNumberRequired = !user.phone_number;
        return { user, token, phone_number_required: phoneNumberRequired };
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
    static async requestAdmin2FA(email) {
        const userRes = await database_1.pool.query('SELECT role FROM users WHERE email = $1', [email]);
        const user = userRes.rows[0];
        if (!user || user.role !== types_1.UserRole.ADMIN) {
            throw new Error('Unauthorized');
        }
        await otp_service_1.OTPService.generateOTP(env_1.env.GMAIL_USER_EMAIL || email);
        return { message: 'Verification code sent' };
    }
    static async verifyAdmin2FA(email, code) {
        const isValid = await otp_service_1.OTPService.verifyOTP(env_1.env.GMAIL_USER_EMAIL || email, code);
        if (!isValid) {
            throw new Error('Invalid or expired verification code');
        }
        const userRes = await database_1.pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = userRes.rows[0];
        if (!user || user.role !== types_1.UserRole.ADMIN) {
            throw new Error('Unauthorized');
        }
        const token = this.generateToken(user);
        return { user, token };
    }
    static generateToken(user) {
        return jsonwebtoken_1.default.sign({ id: user.id, role: user.role, email: user.email }, env_1.env.JWT_SECRET, { expiresIn: '30d', algorithm: 'HS256' });
    }
    static verifyToken(token) {
        return jsonwebtoken_1.default.verify(token, env_1.env.JWT_SECRET, { algorithms: ['HS256'] });
    }
}
exports.AuthService = AuthService;
//# sourceMappingURL=auth.service.js.map