import { Request, Response, NextFunction } from 'express';
/**
 * Basic rate limiting middleware using Redis.
 * Limits requests based on client IP.
 */
export declare const rateLimitMiddleware: (req: Request, res: Response, next: NextFunction) => Promise<Response<any, Record<string, any>> | undefined>;
