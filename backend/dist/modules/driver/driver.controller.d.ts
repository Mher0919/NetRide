import { Response } from 'express';
export declare class DriverController {
    static getProfile(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static updateProfile(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static verifyIdentity(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static onboard(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static getVehicles(req: any, res: Response): Promise<void>;
}
