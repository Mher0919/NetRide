import { Request, Response } from 'express';
export declare class UploadService {
    static upload(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
}
