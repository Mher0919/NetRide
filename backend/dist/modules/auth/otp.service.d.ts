export declare class OTPService {
    /** How long a code stays valid. */
    static readonly CODE_TTL_MS: number;
    /** Failed verification attempts before the code is voided. */
    static readonly MAX_ATTEMPTS = 5;
    /** SHA-256 digest of the raw code — the only form ever stored. */
    static hashCode(code: string): string;
    static generateOTP(email: string): Promise<string>;
    static verifyOTP(email: string, code: string): Promise<boolean>;
}
