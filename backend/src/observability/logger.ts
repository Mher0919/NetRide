// backend/src/observability/logger.ts
//
// Structured JSON logging via pino. Replaces ad-hoc `console.log`
// calls so logs can be shipped to CloudWatch / Loki / Datadog.
//
// Conventions:
//   - Use `logger.info({ ctx })` for hot-path events (request log, match log).
//   - Use `logger.warn` for recoverable issues (cache miss, fallback used).
//   - Use `logger.error({ err }, "msg")` for unexpected failures.
//   - Never log secrets (passwords, JWTs, full payment payloads).
//
// The dev-only pretty transport is loaded lazily so production logs
// stay machine-parseable.

import pino from 'pino';
import { env } from '../config/env';

const isDev = env.NODE_ENV === 'development';

export const logger = pino({
  level: env.PINO_LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  base: {
    service: 'netride-backend',
    env: env.NODE_ENV,
    pid: process.pid,
  },
  // ISO timestamps are easier to grep in production log aggregators.
  timestamp: pino.stdTimeFunctions.isoTime,
  // Redact obvious secret fields if they ever leak into a log context.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.password_hash',
      '*.token',
      '*.jwt',
      '*.secret',
    ],
    censor: '[REDACTED]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        },
      }
    : {}),
});

/**
 * Build a child logger for a single request. Attach the request id
 * to every log line emitted while handling that request so a single
 * rider action can be traced across services.
 */
export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
