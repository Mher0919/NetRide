import { Request, Response, NextFunction } from 'express';
export interface AuthRequest extends Request {
    user?: {
        id: string;
        role: string;
        email: string;
    };
}
export declare const authMiddleware: (req: AuthRequest, res: Response, next: NextFunction) => void | Response<any, Record<string, any>>;
