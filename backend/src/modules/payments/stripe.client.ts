// backend/src/modules/payments/stripe.client.ts
//
// Stripe client + environment interlock.
// ---------------------------------------------------------------------------
// Safety rules (non-negotiable):
//   * Live keys (sk_live_…) are REFUSED unless STRIPE_ALLOW_LIVE=true AND
//     NODE_ENV=production. A dev/test process can never faintly touch live.
//   * With no STRIPE_SECRET_KEY the integration is "unconfigured": every
//     Stripe-backed code path throws a typed StripeNotConfiguredError and
//     the caller degrades to the legacy wallet rail. Nothing is faked.
//   * Secrets never leave the server; clients only ever see publishable
//     configuration (mode + publishable key) through a read-only endpoint.

import Stripe from 'stripe';
import { env } from '../../config/env';

export class StripeNotConfiguredError extends Error {
  readonly code = 'STRIPE_NOT_CONFIGURED';
  constructor() {
    super('Stripe is not configured on this server');
  }
}

export class StripeLiveModeError extends Error {
  readonly code = 'STRIPE_LIVE_MODE_BLOCKED';
  constructor() {
    super('Live Stripe keys are blocked in this environment');
  }
}

let cached: Stripe | null = null;

export function isStripeConfigured(): boolean {
  return !!env.STRIPE_SECRET_KEY;
}

export function stripeKeyIsLive(key: string | undefined = env.STRIPE_SECRET_KEY): boolean {
  return !!key && key.startsWith('sk_live_');
}

export function isStripeLiveAllowed(): boolean {
  return env.STRIPE_ALLOW_LIVE === true && env.NODE_ENV === 'production';
}

/**
 * Throws when Stripe cannot be used in this process. Called before every
 * Stripe API call so a misconfigured environment fails loudly, never
 * silently against the wrong account.
 */
export function assertStripeUsable(): void {
  if (!env.STRIPE_SECRET_KEY) throw new StripeNotConfiguredError();
  if (stripeKeyIsLive() && !isStripeLiveAllowed()) throw new StripeLiveModeError();
}

export function getStripe(): Stripe {
  assertStripeUsable();
  if (!cached) {
    cached = new Stripe(env.STRIPE_SECRET_KEY as string, {
      // Pin the API version explicitly so an account-level default upgrade
      // can never change request/response semantics underneath the app.
      apiVersion: '2026-09-30.endive' as Stripe.LatestApiVersion,
      maxNetworkRetries: 2,
      timeout: 20_000,
      appInfo: { name: 'NetRide', version: '1.0.0' },
    });
  }
  return cached;
}

/** 'live' | 'test' | 'unconfigured' — safe to expose to authenticated UIs. */
export function stripeMode(): 'live' | 'test' | 'unconfigured' {
  if (!env.STRIPE_SECRET_KEY) return 'unconfigured';
  return stripeKeyIsLive() ? 'live' : 'test';
}

/** Reset the memoized client (tests / key rotation in process). */
export function resetStripeClient(): void {
  cached = null;
}
