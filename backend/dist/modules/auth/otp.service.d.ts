/**
 * Purpose of a one-time code. Each authentication flow uses its own purpose
 * so a code issued for one flow can never be consumed by another.
 */
export type OtpPurpose = 'LOGIN' | 'PORTAL_LOGIN' | 'PORTAL_RESET' | 'ADMIN_2FA';
export declare class OTPService {
    /** How long a code stays valid. */
    static readonly CODE_TTL_MS: number;
    /** Failed verification attempts before the code is voided. */
    static readonly MAX_ATTEMPTS = 5;
    /** Minimum interval between two codes for the same email+purpose. */
    static readonly RESEND_COOLDOWN_MS: number;
    /** SHA-256 digest of the raw code — the only form ever stored. */
    static hashCode(code: string): string;
    /** A code is exactly six decimal digits. */
    static isWellFormedCode(code: unknown): code is string;
    private static cooldownKey;
    /**
     * True when the caller must generate the code (cooldown allows it).
     * Fails open when Redis is unavailable so a Redis outage can never make
     * authentication impossible; the endpoint-level rate limits remain in force.
     */
    private static reserveGeneration;
    private static clearCooldown;
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
    static generateOTP(email: string, purpose: OtpPurpose, options?: {
        deliverTo?: string;
    }): Promise<string | null>;
    static verifyOTP(email: string, code: string, purpose: OtpPurpose): Promise<boolean>;
    /** Dev-only escape hatch; requires an explicit opt-in env flag. */
    private static devBypassEnabled;
}
