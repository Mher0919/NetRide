import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

const FILE_URL_PATTERN = /^\/api\/files\//;
const API_BASE = env.APP_URL.replace(/\/$/, '');

/**
 * Express middleware that intercepts JSON responses and resolves any
 * `/api/files/{id}` relative URLs to fully-qualified URLs using APP_URL.
 *
 * This ensures that clients (admin dashboard, Flutter) always receive
 * absolute URLs that can be loaded directly, while the database stores
 * portable relative references.
 */
export function resolveFileUrls(req: Request, res: Response, next: NextFunction) {
  const originalJson = res.json.bind(res);

  res.json = function (body: any) {
    if (body !== null && body !== undefined) {
      if (typeof body === 'object') {
        transformObject(body);
      } else if (typeof body === 'string' && FILE_URL_PATTERN.test(body)) {
        body = `${API_BASE}${body}`;
      }
    }
    return originalJson(body);
  } as any;

  next();
}

function transformObject(obj: any): void {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === 'string' && FILE_URL_PATTERN.test(obj[i])) {
        obj[i] = `${API_BASE}${obj[i]}`;
      } else if (obj[i] !== null && typeof obj[i] === 'object') {
        transformObject(obj[i]);
      }
    }
  } else if (obj !== null && typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (typeof val === 'string' && FILE_URL_PATTERN.test(val)) {
        obj[key] = `${API_BASE}${val}`;
      } else if (val !== null && typeof val === 'object') {
        transformObject(val);
      }
    }
  }
}
