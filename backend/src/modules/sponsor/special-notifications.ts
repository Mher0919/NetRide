// backend/src/modules/sponsor/special-notifications.ts
//
// Rider-facing notifications for the sponsorship/SPECIALS lifecycle.
// The raw validation code is delivered ONLY to the rider who owns the
// redemption (in-app + FCM) — it is never written to any log or table in
// plaintext (spec §99).

import { notifyUser, fmtMoney } from '../../services/notification.service';

/**
 * Ride completed → the rider's special validation code is ready.
 * `code` is only provided on the ride-completion call (rider side);
 * the sponsor-validation call passes the event without re-sending it.
 */
export async function notifySpecialRewardReady(
  riderId: string,
  redemptionId: string,
  code: string | null,
): Promise<void> {
  await notifyUser({
    userId: riderId,
    role: 'rider',
    type: 'special_reward_ready' ,
    title: 'Your special is ready',
    body: code
      ? `Show this code at the business: ${code}`
      : 'The business confirmed your visit',
    data: { redemptionId, code: code ?? '' },
    eventId: `special:ready:${redemptionId}`,
    route: '/trip',
  });
}

/**
 * Sponsor validated the visit and the special settled: the rider's discount
 * stays applied to the ride fare. NEW MODEL — no refund or credits are ever
 * issued for a special (the old cash-back flow was removed).
 */
export async function notifySpecialSettled(
  riderId: string,
  redemptionId: string,
  discountCents: number,
): Promise<void> {
  await notifyUser({
    userId: riderId,
    role: 'rider',
    type: 'special_settled',
    title: 'Visit confirmed',
    body: `Your discount of $${fmtMoney(discountCents)} was applied to the ride`,
    data: { redemptionId, discountCents: String(discountCents) },
    eventId: `special:settled:${redemptionId}`,
    route: '/trip',
  });
}
