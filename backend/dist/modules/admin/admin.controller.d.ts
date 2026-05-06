import { Request, Response } from 'express';
export declare class AdminController {
    static verifyDriver(req: Request, res: Response): Promise<void>;
    static verifyRider(req: Request, res: Response): Promise<void>;
}
