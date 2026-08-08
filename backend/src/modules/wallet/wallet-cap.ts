// backend/src/modules/wallet/wallet-cap.ts
//
// PURE wallet-charge math — no DB, no socket, no app imports. Kept in its
// own module so unit tests can require it without booting the server.

const clampCents = (n: number): number => {
  const r = Math.round(n);
  return Number.isFinite(r) ? Math.max(0, r) : 0;
};

/**
 * Computes the wallet charge for a ride: the wallet pays the FULL remaining
 * amount (after promos and ride credits) up to the available balance.
 * `chargeForRide` debits exactly this amount (server truth — the client
 * never tells the backend how much to charge).
 */
export function computeWalletCharge(
  amountDueCents: number,
  walletBalanceCents: number,
): { walletChargeCents: number; finalCents: number } {
  const due = clampCents(amountDueCents);
  const balance = clampCents(walletBalanceCents);
  const walletChargeCents = Math.min(due, balance);
  const finalCents = Math.max(0, due - walletChargeCents);
  return { walletChargeCents, finalCents };
}
