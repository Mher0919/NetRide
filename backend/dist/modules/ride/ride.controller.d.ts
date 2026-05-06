import { Response } from 'express';
export declare class RideController {
    static requestRide(req: any, res: Response): Promise<void>;
    static acceptTrip(req: any, res: Response): Promise<void>;
    static rateRide(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static getHistory(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static deleteHistory(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
}
