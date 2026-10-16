import { Request, Response, NextFunction } from 'express';
import { ZodType } from 'zod';
export declare const validate: (schema: ZodType) => (req: Request, res: Response, next: NextFunction) => Promise<Response<any, Record<string, any>> | undefined>;
