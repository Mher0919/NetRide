"use strict";
// backend/src/modules/auth/otp.service.ts
//
// Shared email-verification-code core used by:
//   - mobile email OTP (signup/login verify-otp)
//   - Admin Dashboard 2FA (admin/request-2fa, admin/verify-2fa)
//   - Colab Portal 2FA (portal/auth/verify-2fa)
//   - portal forgot-password reset codes
//
// Security properties (single implementation — every consumer inherits them):
//   * Codes are 6 random digits from crypto.randomInt (never timestamps or
//     sequential values) with a short TTL (10 minutes).
//   * Only the SHA-256 digest of the code is persisted — a DB leak never
//     exposes live codes.
//   * Single-use: a successful verification deletes the row immediately.
//   * A newer code invalidates any previous code for the same email.
//   * Brute-force throttling: each failed attempt is counted; after
//     MAX_ATTEMPTS failures the code is deleted.
//   * Codes are never written to logs — only the email address appears.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OTPService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const database_1 = require("../../config/database");
const email_service_1 = require("../../services/email.service");
class OTPService {
    /** SHA-256 digest of the raw code — the only form ever stored. */
    static hashCode(code) {
        return crypto_1.default.createHash('sha256').update(code, 'utf8').digest('hex');
    }
    static async generateOTP(email) {
        const code = crypto_1.default.randomInt(100000, 999999).toString();
        const expiresAt = new Date(Date.now() + this.CODE_TTL_MS);
        // Clean up old codes for this email (a fresh code invalidates any
        // outstanding one, so stale codes can never be replayed).
        await database_1.pool.query('DELETE FROM verification_codes WHERE email = $1', [email]);
        // Save only the digest — never the plaintext.
        await database_1.pool.query('INSERT INTO verification_codes (email, code_hash, expires_at) VALUES ($1, $2, $3)', [email, this.hashCode(code), expiresAt]);
        // The raw code is delivered directly to the account holder's inbox and
        // is never persisted or logged.
        await email_service_1.EmailService.sendOTP(email, code);
        return code;
    }
    static async verifyOTP(email, code) {
        // DEV BYPASS: Allow '111111' for dummy users in development
        if (process.env.NODE_ENV === 'development' && code === '111111' && email.endsWith('@NetRide.dev')) {
            console.log(`[AUTH] 🛠️ Dev OTP bypass used for ${email}`);
            return true;
        }
        // Reject malformed input before touching the database.
        if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
            return false;
        }
        const res = await database_1.pool.query('SELECT * FROM verification_codes WHERE email = $1 AND code_hash = $2 AND expires_at > NOW()', [email, this.hashCode(code)]);
        if (res.rows.length > 0) {
            // Single-use: consume the code on success.
            await database_1.pool.query('DELETE FROM verification_codes WHERE email = $1', [email]);
            return true;
        }
        // Brute-force throttle: burn one attempt; void the code once the
        // attempt budget is exhausted so an online attack can never try more
        // than MAX_ATTEMPTS guesses against the same code.
        await database_1.pool.query(`DELETE FROM verification_codes
       WHERE email = $1 AND attempts + 1 >= $2`, [email, this.MAX_ATTEMPTS]);
        await database_1.pool.query('UPDATE verification_codes SET attempts = attempts + 1 WHERE email = $1', [email]);
        return false;
    }
}
exports.OTPService = OTPService;
/** How long a code stays valid. */
OTPService.CODE_TTL_MS = 10 * 60 * 1000;
/** Failed verification attempts before the code is voided. */
OTPService.MAX_ATTEMPTS = 5;
//# sourceMappingURL=otp.service.js.map