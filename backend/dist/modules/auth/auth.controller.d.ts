import { Request, Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
export declare class AuthController {
    static signupPassword(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static loginPassword(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static changePassword(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static forgotPassword(req: Request, res: Response): Promise<void>;
    static resetPassword(req: Request, res: Response): Promise<void>;
    static requestPasswordChange(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static deleteAccount(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static deactivateAccount(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static renderResetPasswordForm(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static oauth(req: Request, res: Response): Promise<void>;
    static requestOTP(req: Request, res: Response): Promise<void>;
    static verifyOTP(req: Request, res: Response): Promise<void>;
    static requestPhoneOTP(req: AuthRequest, res: Response): Promise<void>;
    static verifyPhoneOTP(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static requestAdmin2FA(req: Request, res: Response): Promise<void>;
    static verifyAdmin2FA(req: Request, res: Response): Promise<void>;
}
