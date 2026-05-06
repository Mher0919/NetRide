export declare class OTPService {
    static generateOTP(email: string): Promise<string>;
    static verifyOTP(email: string, code: string): Promise<boolean>;
}
