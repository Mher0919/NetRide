import { Request, Response } from 'express';
export declare class UploadService {
    /**
     * Processes a base64 string, saves it to the filesystem, and returns a URL.
     */
    static upload(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
}
