import { UserRole } from '../../types';
export declare class AuthService {
    static requestPhoneOTP(userId: string, phoneNumber: string, role?: string): Promise<{
        status: string;
        message: string;
    } | {
        status: string;
        message?: undefined;
    } | {
        auto_verified: boolean;
        message: string;
    }>;
    static verifyPhoneOTP(userId: string, phoneNumber: string, code: string, role?: string): Promise<{
        success: boolean;
        message: string;
    }>;
    static signupWithPassword(data: {
        email: string;
        full_name: string;
        password: string;
        role: UserRole;
    }): Promise<{
        otp_required: boolean;
        phone_number_required: boolean;
        message: string;
    }>;
    static loginWithPassword(data: {
        email: string;
        password?: string;
        trusted_device_token?: string | null;
    }): Promise<{
        otp_required: boolean;
        email: any;
        message: string;
        user?: undefined;
        token?: undefined;
        phone_number_required?: undefined;
        password_expired?: undefined;
    } | {
        user: any;
        token: string;
        phone_number_required: boolean;
        password_expired: boolean;
        otp_required?: undefined;
        email?: undefined;
        message?: undefined;
    }>;
    static changePassword(userId: string, data: {
        currentPassword?: string;
        newPassword: string;
    }): Promise<{
        message: string;
    }>;
    static forgotPassword(email: string): Promise<{
        message: string;
    }>;
    static resetPassword(token: string, newPassword: string): Promise<{
        message: string;
    }>;
    static requestEmailChange(userId: string, newEmail: string): Promise<{
        message: string;
    }>;
    static verifyEmailChange(token: string): Promise<{
        message: string;
    }>;
    static handleOAuth(data: {
        email: string;
        full_name: string;
        profile_image_url?: string | null;
        role: string;
        token?: string | null;
    }): Promise<{
        user: any;
        token: string;
        phone_number_required: boolean;
    }>;
    static requestOTP(email: string): Promise<{
        message: string;
    }>;
    static verifyOTP(data: {
        email: string;
        code: string;
        full_name?: string;
        role?: string;
    }): Promise<{
        user: any;
        token: string;
        phone_number_required: boolean;
    }>;
    static requestPasswordChange(userId: string, currentPassword: string): Promise<{
        message: string;
    }>;
    static verifyPasswordChangeToken(token: string): Promise<{
        userId: string;
    }>;
    static deleteAccount(userId: string): Promise<{
        message: string;
    }>;
    static deactivateAccount(userId: string): Promise<{
        message: string;
    }>;
    static requestAdmin2FA(email: string): Promise<{
        message: string;
    }>;
    static verifyAdmin2FA(email: string, code: string): Promise<{
        user: any;
        token: string;
    }>;
    static generateToken(user: any): string;
    static verifyToken(token: string): any;
}
