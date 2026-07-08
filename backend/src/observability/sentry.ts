// backend/src/observability/sentry.ts
//
// Sentry init. Captures unhandled exceptions and (optionally)
// performance traces. We only init when SENTRY_DSN is set so
// dev environments run without contacting Sentry at all.
//
// IMPORTANT: must run BEFORE any other module that throws at import
// time. app.ts calls this as the very first import-side-effect.

import { env } from '../config/env';
import { logger } from './logger';

let initialized = false;

export function initSentry() {
  if (initialized) return;
  if (!env.SENTRY_DSN) {
    logger.info('[SENTRY] SENTRY_DSN not set — error tracking disabled');
    return;
  }

  // Lazy require so the dependency is only loaded when DSN is set.
  // Avoids paying the import cost (~100ms) in dev / tests.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Sentry = require('@sentry/node');

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    release: process.env.GIT_SHA || 'dev',
    // Sample 20% of traces in production, 100% in dev. Tunable.
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.2 : 1.0,
    // Don't ship health-check pings; they're noise.
    ignoreErrors: ['ECONNRESET', 'ECONNREFUSED'],
    beforeSend(event: any) {
      // Strip the same secrets pino redacts.
      if (event.request?.cookies) delete event.request.cookies;
      if (event.request?.headers?.authorization)
        event.request.headers.authorization = '[REDACTED]';
      return event;
    },
  });

  initialized = true;
  logger.info('[SENTRY] ✅ Sentry initialized');
}
