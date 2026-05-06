import { Request, Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { z } from 'zod';
export declare const updateProfileSchema: z.ZodObject<{
    body: z.ZodObject<{
        phone_number: z.ZodOptional<z.ZodString>;
        full_name: z.ZodOptional<z.ZodString>;
        profile_image_url: z.ZodOptional<z.ZodString>;
        date_of_birth: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        full_name?: string | undefined;
        profile_image_url?: string | undefined;
        phone_number?: string | undefined;
        date_of_birth?: string | undefined;
    }, {
        full_name?: string | undefined;
        profile_image_url?: string | undefined;
        phone_number?: string | undefined;
        date_of_birth?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    body: {
        full_name?: string | undefined;
        profile_image_url?: string | undefined;
        phone_number?: string | undefined;
        date_of_birth?: string | undefined;
    };
}, {
    body: {
        full_name?: string | undefined;
        profile_image_url?: string | undefined;
        phone_number?: string | undefined;
        date_of_birth?: string | undefined;
    };
}>;
export declare const verifyIdentitySchema: z.ZodObject<{
    body: z.ZodObject<{
        id_photo_front_url: z.ZodString;
        id_photo_back_url: z.ZodString;
        date_of_birth: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id_photo_front_url: string;
        id_photo_back_url: string;
        date_of_birth?: string | undefined;
    }, {
        id_photo_front_url: string;
        id_photo_back_url: string;
        date_of_birth?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    body: {
        id_photo_front_url: string;
        id_photo_back_url: string;
        date_of_birth?: string | undefined;
    };
}, {
    body: {
        id_photo_front_url: string;
        id_photo_back_url: string;
        date_of_birth?: string | undefined;
    };
}>;
export declare class UserController {
    static getProfile(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static updateProfile(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static verifyIdentity(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static requestEmailChange(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static verifyEmailChange(req: Request, res: Response): Promise<void>;
}
