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
//   * Every code is BOUND TO A PURPOSE. A portal password-reset code can
//     never be replayed as a login code (or vice versa), and a consumer
//     login code can never satisfy the admin 2FA flow.
//   * Single-use: a successful verification deletes the row immediately.
//   * A newer code invalidates any previous code for the same email+purpose.
//   * Brute-force throttling: each failed attempt is counted per email+purpose;
//     after MAX_ATTEMPTS failures the code is deleted.
//   * Resend cooldown: at most one code is mailed per (email, purpose) per
//     RESEND_COOLDOWN_MS — the endpoint cannot be abused as a mail/SMS bomb.
//   * Codes are never written to logs — only the email address appears.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OTPService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const database_1 = require("../../config/database");
const redis_1 = require("../../config/redis");
const email_service_1 = require("../../services/email.service");
class OTPService {
    /** SHA-256 digest of the raw code — the only form ever stored. */
    static hashCode(code) {
        return crypto_1.default.createHash('sha256').update(code, 'utf8').digest('hex');
    }
    /** A code is exactly six decimal digits. */
    static isWellFormedCode(code) {
        return typeof code === 'string' && /^\d{6}$/.test(code);
    }
    static cooldownKey(email, purpose) {
        return `otp_cooldown:${purpose}:${email}`;
    }
    /**
     * True when the caller must generate the code (cooldown allows it).
     * Fails open when Redis is unavailable so a Redis outage can never make
     * authentication impossible; the endpoint-level rate limits remain in force.
     */
    static async reserveGeneration(email, purpose) {
        try {
            const res = await redis_1.redis.set(this.cooldownKey(email, purpose), '1', 'EX', Math.ceil(this.RESEND_COOLDOWN_MS / 1000), 'NX');
            return res === 'OK';
        }
        catch (err) {
            console.warn(`[OTP] cooldown check failed (allowing): ${err.message}`);
            return true;
        }
    }
    static async clearCooldown(email, purpose) {
        try {
            await redis_1.redis.del(this.cooldownKey(email, purpose));
        }
        catch {
            // best-effort
        }
    }
    /**
     * Generates, stores (as a digest) and emails a fresh code bound to
     * `purpose`.
     *
     * @param email     The account the code is bound to (the verification key).
     * @param purpose   The flow the code belongs to.
     * @param deliverTo Optional alternative recipient (admin 2FA codes are
     *                  bound to the admin's own account but delivered to the
     *                  shared admin notification inbox). Defaults to `email`.
     * @returns the raw code when one was generated, or null when the resend
     *          cooldown suppressed the send (a previously issued code — if any
     *          — remains valid).
     */
    static async generateOTP(email, purpose, options) {
        const normalized = String(email ?? '').trim().toLowerCase();
        if (!normalized)
            throw new Error('Email is required');
        const allowed = await this.reserveGeneration(normalized, purpose);
        if (!allowed) {
            return null;
        }
        const code = crypto_1.default.randomInt(100000, 1000000).toString();
        const expiresAt = new Date(Date.now() + this.CODE_TTL_MS);
        // Clean up old codes for this email+purpose (a fresh code invalidates any
        // outstanding one, so stale codes can never be replayed).
        await database_1.pool.query('DELETE FROM verification_codes WHERE email = $1 AND purpose = $2', [normalized, purpose]);
        // Save only the digest — never the plaintext.
        await database_1.pool.query('INSERT INTO verification_codes (email, code_hash, expires_at, purpose) VALUES ($1, $2, $3, $4)', [normalized, this.hashCode(code), expiresAt, purpose]);
        // The raw code is delivered directly to the account holder's inbox and
        // is never persisted or logged.
        await email_service_1.EmailService.sendOTP(options?.deliverTo ?? normalized, code);
        return code;
    }
    static async verifyOTP(email, code, purpose) {
        const normalized = String(email ?? '').trim().toLowerCase();
        // Optional explicit dev-only bypass. Disabled by default and impossible
        // in production: it requires BOTH a non-production NODE_ENV and the
        // ALLOW_DEV_OTP_BYPASS opt-in. Never a static code accepted implicitly.
        if (this.devBypassEnabled() && code === '111111' && normalized.endsWith('@netride.dev')) {
            console.log(`[AUTH] dev OTP bypass used for ${normalized}`);
            return true;
        }
        // Reject malformed input before touching the database.
        if (!this.isWellFormedCode(code)) {
            return false;
        }
        const res = await database_1.pool.query(`SELECT * FROM verification_codes
       WHERE email = $1 AND purpose = $2 AND code_hash = $3 AND expires_at > NOW()`, [normalized, purpose, this.hashCode(code)]);
        if (res.rows.length > 0) {
            // Single-use: consume the code on success and lift the resend cooldown
            // so the account can immediately request a fresh code if needed.
            await database_1.pool.query('DELETE FROM verification_codes WHERE email = $1 AND purpose = $2', [normalized, purpose]);
            await this.clearCooldown(normalized, purpose);
            return true;
        }
        // Brute-force throttle: burn one attempt; void the code once the
        // attempt budget is exhausted so an online attack can never try more
        // than MAX_ATTEMPTS guesses against the same code.
        await database_1.pool.query(`DELETE FROM verification_codes
       WHERE email = $1 AND purpose = $2 AND attempts + 1 >= $3`, [normalized, purpose, this.MAX_ATTEMPTS]);
        await database_1.pool.query('UPDATE verification_codes SET attempts = attempts + 1 WHERE email = $1 AND purpose = $2', [normalized, purpose]);
        return false;
    }
    /** Dev-only escape hatch; requires an explicit opt-in env flag. */
    static devBypassEnabled() {
        return (process.env.NODE_ENV !== 'production' &&
            process.env.ALLOW_DEV_OTP_BYPASS === 'true');
    }
}
exports.OTPService = OTPService;
/** How long a code stays valid. */
OTPService.CODE_TTL_MS = 10 * 60 * 1000;
/** Failed verification attempts before the code is voided. */
OTPService.MAX_ATTEMPTS = 5;
/** Minimum interval between two codes for the same email+purpose. */
OTPService.RESEND_COOLDOWN_MS = 60 * 1000;
//# sourceMappingURL=otp.service.js.map