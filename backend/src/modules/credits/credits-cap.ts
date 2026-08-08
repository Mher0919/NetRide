// backend/src/modules/credits/credits-cap.ts
//
// PURE credit-application math — no DB, no socket, no app imports. Kept in
// its own module so unit tests can require it without booting the server.

export const roundCents = (n: number): number => Math.round(n);

/**
 * Pure cap-selection math for applying credits to a ride:
 * `min(balanceCents, remainingFareCents, requestedCents)` with all inputs
 * clamped at zero. `applyToRide` debits exactly this amount (server truth —
 * the client's `creditUseCents` is only a hint).
 */
const clampCents = (n: number): number => {
  const r = Math.round(n);
  return Number.isFinite(r) ? Math.max(0, r) : 0;
};

export function computeCreditApplication(
  balanceCents: number,
  remainingFareCents: number,
  requestedCents?: number,
): number {
  const balance = clampCents(balanceCents);
  const remaining = clampCents(remainingFareCents);
  const requested =
    requestedCents != null ? clampCents(requestedCents) : balance;
  return Math.min(balance, remaining, requested);
}
