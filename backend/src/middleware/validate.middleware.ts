// backend/src/middleware/validate.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { ZodType, ZodError } from 'zod';
import { parseBoundedAsync } from '../utils/zod-parse';

export const validate = (schema: ZodType) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // parseBoundedAsync passes the CVE-2023-54404 `abortEarly` mitigation
      // so a hostile payload cannot fan out into one issue per element.
      await parseBoundedAsync(schema, {
        body: req.body,
        query: req.query,
        params: req.params,
      });
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          error: 'Validation failed. Please ensure all required fields are provided and correctly formatted.',
          details: error.issues.map(err => ({
            field: err.path.join('.'),
            message: err.message,
          })),
        });
      }
      return res.status(500).json({ error: 'An internal error occurred during request validation.' });
    }
  };
};