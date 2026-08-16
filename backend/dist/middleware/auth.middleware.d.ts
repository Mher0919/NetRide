import { Request, Response, NextFunction } from 'express';
export interface AuthRequest extends Request {
    user?: {
        id: string;
        role: string;
        email: string;
    };
}
export declare const authMiddleware: (req: AuthRequest, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
export declare const adminMiddleware: (req: AuthRequest, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
/**
 * SPONSOR portal guard. The JWT for portal sessions carries role='SPONSOR'
 * plus the `sponsorId` claim (issued by SponsorService). Sponsors can never
 * escalate to ADMIN/RIDER and vice versa — the claim is verified against the
 * sponsor_portal_accounts row so disabled accounts are rejected instantly.
 * (Spec §44-45, §78-80: sponsor A must never see sponsor B's data — all
 * portal queries are scoped by req.sponsor.id below.)
 */
export declare const sponsorMiddleware: (req: any, res: Response, next: NextFunction) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const riderMiddleware: (req: AuthRequest, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
export declare const driverMiddleware: (req: AuthRequest, res: Response, next: NextFunction) => Promise<void | Response<any, Record<string, any>>>;
