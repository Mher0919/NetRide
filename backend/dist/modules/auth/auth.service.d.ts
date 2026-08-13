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
        app_role?: string;
    }): Promise<{
        otp_required: boolean;
        email: any;
        message: string;
        user?: undefined;
        token?: undefined;
        phone_number_required?: undefined;
        password_expired?: undefined;
        onboarding?: undefined;
    } | {
        otp_required: boolean;
        message: string;
        email?: undefined;
        user?: undefined;
        token?: undefined;
        phone_number_required?: undefined;
        password_expired?: undefined;
        onboarding?: undefined;
    } | {
        user: any;
        token: string;
        phone_number_required: boolean;
        password_expired: boolean;
        onboarding: {
            rider: {
                onboarding_complete: boolean;
                phone_verified: boolean;
                phone_required: boolean;
            };
            driver: {
                onboarding_complete: boolean;
                phone_verified: boolean;
                exists: boolean;
            };
            roles: string[];
        };
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
    static getOnboardingStatus(userId: string): Promise<{
        rider: {
            onboarding_complete: boolean;
            phone_verified: boolean;
            phone_required: boolean;
        };
        driver: {
            onboarding_complete: boolean;
            phone_verified: boolean;
            exists: boolean;
        };
        roles: string[];
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
        onboarding: {
            rider: {
                onboarding_complete: boolean;
                phone_verified: boolean;
                phone_required: boolean;
            };
            driver: {
                onboarding_complete: boolean;
                phone_verified: boolean;
                exists: boolean;
            };
            roles: string[];
        };
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
        onboarding: {
            rider: {
                onboarding_complete: boolean;
                phone_verified: boolean;
                phone_required: boolean;
            };
            driver: {
                onboarding_complete: boolean;
                phone_verified: boolean;
                exists: boolean;
            };
            roles: string[];
        };
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
    static generateToken(user: any, roleOverride?: string): string;
    /**
     * Resolve the ACTIVE session role from the connecting application's context.
     *
     * A single authenticated identity may own both a Rider profile (the `users`
     * row) and a Driver profile (the `drivers` row). The backend must never
     * guess the active role from `users.role` alone — it must use the explicit
     * application context supplied by the client (`appRoleHint`, e.g. "DRIVER"
     * from the Driver App, "RIDER" from the Rider App), and only honor it when
     * the user actually holds that profile.
     *
     * Returns the resolved role plus the resolved profile ids so downstream
     * realtime/presence/matching logic always operates on the correct profile.
     */
    static resolveActiveRole(userId: string, appRoleHint?: string | null): Promise<{
        role: string;
        driverId: string | null;
        riderId: string | null;
    }>;
    static verifyToken(token: string): any;
}
