import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
export declare class AdminController {
    static getStats(req: AuthRequest, res: Response): Promise<void>;
    static getUsers(req: AuthRequest, res: Response): Promise<void>;
    static getUserById(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static verifyUser(req: AuthRequest, res: Response): Promise<void>;
    static rejectUser(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static setPending(req: AuthRequest, res: Response): Promise<void>;
    static getLogs(req: AuthRequest, res: Response): Promise<void>;
    static getRides(req: AuthRequest, res: Response): Promise<void>;
    static getRideById(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static verifyInspection(req: AuthRequest, res: Response): Promise<void>;
    static getRideAudit(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static getLiveDrivers(req: AuthRequest, res: Response): Promise<void>;
    /**
     * Fleet-wide view of recent speeding violations, newest first.
     * Used by the /speeding admin dashboard.
     */
    static getSpeedingViolations(req: AuthRequest, res: Response): Promise<void>;
    /**
     * Per-driver speeding history. Used in UserDetail's Safety section.
     */
    static getDriverSpeeding(req: AuthRequest, res: Response): Promise<void>;
    /**
     * List drivers flagged as dangerous. Includes violation counts so
     * the admin list view can sort by severity.
     */
    static getDangerousDrivers(req: AuthRequest, res: Response): Promise<void>;
    /**
     * Manually clear the dangerous flag after admin review (warning
     * issued, retraining completed, etc). Writes an audit_log row.
     */
    static clearDangerousFlag(req: AuthRequest, res: Response): Promise<void>;
    static listProfileChanges(req: AuthRequest, res: Response): Promise<void>;
    static getProfileChange(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static approveProfileChange(req: AuthRequest, res: Response): Promise<void>;
    static rejectProfileChange(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static listPayoutCards(req: AuthRequest, res: Response): Promise<void>;
    static approvePayoutCard(req: AuthRequest, res: Response): Promise<void>;
    static rejectPayoutCard(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static listPayouts(req: AuthRequest, res: Response): Promise<void>;
    static markPayoutPaid(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
}
