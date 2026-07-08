// backend/src/middleware/pinoHttp.ts
//
// HTTP request logger. Mounted as the FIRST middleware so every
// request gets a log line, even ones rejected by auth or rate-limit
// downstream. We keep the log line structured (one line per request)
// and the per-request child logger on `res.locals.log` for handlers
// to attach context.

import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { childLogger, logger as rootLogger } from '../observability/logger';
import { httpRequestsTotal, httpRequestDurationSeconds } from '../observability/metrics';
import type { Logger } from 'pino';

export function requestContext(req: Request, res: Response, next: NextFunction) {
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  res.setHeader('x-request-id', requestId);
  // `locals` is typed as a generic record; we use a loose cast for the
  // two keys we attach. Handlers can read `res.locals.log` / `.requestId`.
  const locals = res.locals as { log?: Logger; requestId?: string };
  locals.requestId = requestId;
  locals.log = childLogger({ requestId, method: req.method, path: req.path });
  next();
}

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;
    // Use the route's matched pattern (e.g. `/api/ride/:id`) when
    // available so we don't blow up Prometheus cardinality with raw
    // /api/ride/abc-123 UUIDs.
    const route = (req as any).route?.path
      ? `${req.baseUrl || ''}${(req as any).route.path}`
      : req.path;
    const labels = { method: req.method, route, status: String(res.statusCode) };

    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSec);

    const log = (res.locals as { log?: Logger }).log ?? rootLogger;
    const level =
      res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    log[level](
      {
        status: res.statusCode,
        durationMs: Math.round(durationSec * 1000),
        route,
      },
      'http_request',
    );
  });
  next();
}
