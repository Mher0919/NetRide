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
      : 'The business confirmed your visit — collect your reward now',
    data: { redemptionId, code: code ?? '' },
    eventId: `special:ready:${redemptionId}`,
    route: '/trip',
  });
}

/** Sponsor validated the visit → the rider picks REFUND or CREDITS. */
export async function notifySpecialRewardCredited(
  riderId: string,
  redemptionId: string,
  amountCents: number,
): Promise<void> {
  await notifyUser({
    userId: riderId,
    role: 'rider',
    type: 'special_reward_credited' ,
    title: 'Special reward credited',
    body: `$${fmtMoney(amountCents)} in ride credits were added to your account`,
    data: { redemptionId, amountCents: String(amountCents) },
    eventId: `special:credited:${redemptionId}`,
    route: '/credits',
  });
}

/** Money-back refund posted to the rider's wallet. */
export async function notifySpecialRefunded(
  riderId: string,
  redemptionId: string,
  amountCents: number,
): Promise<void> {
  await notifyUser({
    userId: riderId,
    role: 'rider',
    type: 'special_refunded' ,
    title: 'Special refund received',
    body: `$${fmtMoney(amountCents)} was refunded to your wallet`,
    data: { redemptionId, amountCents: String(amountCents) },
    eventId: `special:refunded:${redemptionId}`,
    route: '/wallet',
  });
}
