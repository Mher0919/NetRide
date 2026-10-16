// backend/src/security/tip-policy.ts
//
// Pure bounds for post-ride tips. A tip is credited to the driver's wallet,
// so an unbounded client-supplied amount is a wallet-minting vulnerability:
// the cap must be computed server-side from the ride fare, never from the
// request body.

export const TIP_MIN_CENTS = 0;
export const TIP_HARD_CAP_DOLLARS = 100;
export const TIP_MIN_FARE_DOLLARS = 5;

/**
 * Maximum tip (whole dollars) for a ride whose fare is `fareDollars`.
 * At most the fare, never more than the hard cap, never less than $5 so
 * low/zero-fare test rides can still be tipped.
 */
export function maxTipDollarsForFare(fareDollars: number): number {
  const safeFare = Number.isFinite(fareDollars) ? Math.max(0, fareDollars) : 0;
  return Math.min(TIP_HARD_CAP_DOLLARS, Math.max(TIP_MIN_FARE_DOLLARS, Math.ceil(safeFare)));
}

export interface TipValidation {
  ok: boolean;
  amount?: number;
  error?: string;
}

export function validateTipAmount(rawAmount: unknown, fareDollars: number): TipValidation {
  const numeric = typeof rawAmount === 'number' ? rawAmount : parseFloat(String(rawAmount));
  if (!Number.isFinite(numeric) || numeric < TIP_MIN_CENTS) {
    return { ok: false, error: 'A valid tip amount is required.' };
  }
  const maxTip = maxTipDollarsForFare(fareDollars);
  if (numeric > maxTip) {
    return { ok: false, error: `Tip amount cannot exceed $${maxTip}.` };
  }
  return { ok: true, amount: numeric };
}
