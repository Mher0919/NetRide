// backend/src/middleware/securityHeaders.middleware.ts
//
// Central security-header policy for the API. Registered before every route
// (including the Stripe webhook and error handler) so all response paths —
// success, redirect and error — carry the headers.
//
// HSTS is only sent when the request actually arrived over TLS: behind the
// Render proxy `req.secure` reflects `X-Forwarded-Proto` (the app sets
// `trust proxy`), while plain-HTTP local development never receives the
// header. This avoids pinning local browsers to HTTPS by mistake.

import { Request, Response, NextFunction } from 'express';

export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.secure) {
    // No includeSubDomains: the deployment domain is shared (onrender.com),
    // and 180 days is already a strong commitment for the API host.
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  next();
}
