import { UserRole } from '../../types';
export declare class AuthService {
    static signupWithPassword(data: {
        email: string;
        full_name: string;
        password: string;
        role: UserRole;
    }): Promise<{
        otp_required: boolean;
        message: string;
    }>;
    static loginWithPassword(data: {
        email: string;
        password?: string;
    }): Promise<{
        user: any;
        token: string;
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
        profile_image_url?: string;
        role: string;
    }): Promise<{
        user: any;
        token: string;
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
    static generateToken(user: any): string;
    static verifyToken(token: string): any;
}
