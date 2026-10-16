// backend/src/modules/payments/return-target.ts
//
// Deep-link return targets for the Stripe Checkout landing pages. The
// `kind` and `state` query values arrive from a browser navigation
// (attacker-controllable), so both are allowlisted before being echoed into
// the netride:// deep link. Unvalidated values would be a deep-link
// injection / open-redirect vector for the mobile apps.

export const PAYMENT_RETURN_KINDS = [
  'card',
  'topup',
  'driver_onboarding',
] as const;

export const PAYMENT_RETURN_STATES = [
  'success',
  'cancel',
  'refresh',
  'done',
] as const;

export type PaymentReturnKind = (typeof PAYMENT_RETURN_KINDS)[number];
export type PaymentReturnState = (typeof PAYMENT_RETURN_STATES)[number];

export function sanitizePaymentReturnKind(value: unknown): PaymentReturnKind {
  return (PAYMENT_RETURN_KINDS as readonly string[]).includes(String(value))
    ? (value as PaymentReturnKind)
    : 'card';
}

export function sanitizePaymentReturnState(value: unknown): PaymentReturnState {
  return (PAYMENT_RETURN_STATES as readonly string[]).includes(String(value))
    ? (value as PaymentReturnState)
    : 'success';
}

export function buildMobilePaymentReturnUrl(
  base: string,
  kind: unknown,
  state: unknown,
): string {
  const safeKind = sanitizePaymentReturnKind(kind);
  const safeState = sanitizePaymentReturnState(state);
  return `${base}?kind=${encodeURIComponent(safeKind)}&state=${encodeURIComponent(safeState)}`;
}
