// backend/src/services/notification.service.ts
//
// REAL PHONE NOTIFICATIONS — event-sourced notification pipeline.
// ---------------------------------------------------------------------------
// Single, typed entry point for every user-facing notification on the
// platform. For each real-world event the backend processes:
//
//   1. RECORD — a `notifications` row is persisted (idempotently: the row is
//      keyed by an `eventId` like `ride:completed:{tripId}`. The partial
//      UNIQUE index on notifications.event_id guarantees exactly ONE row
//      per event even if multiple backend instances handle the event at the
//      same time — the loser of the INSERT race sees zero rows returned and
//      skips the push entirely → no double notifications, ever).
//   2. DELIVER — the FCM push is fanned out to every device token of the
//      recipient (sendPushAll). When the recipient is online, the same
//      payload is ALSO emitted to their socket room (`notificationReceived`)
//      so the in-app history feed + badge update instantly.
//   3. DEEP LINK — `data.route` carries the app route the client should
//      open when the notification is tapped (`/trip`, `/credits`, ...).
//
// Fire-and-forget discipline: every notify* call is expected to be invoked
// with `.catch(() => undefined)` — a notification failure must never break
// the ride lifecycle that produced it.

import { pool } from '../config/database';
import { io } from '../app';
import { redis } from '../config/redis';
import { logger } from '../observability/logger';
import { sendPushAll, PushPayload } from './push-notification.service';

export type NotificationRole = 'rider' | 'driver';

export type NotificationType =
  | 'ride_accepted'
  | 'driver_arrived'
  | 'ride_started'
  | 'ride_completed'
  | 'ride_cancelled'
  | 'promo_applied'
  | 'credits_applied'
  | 'wallet_charged'
  | 'credits_earned'
  | 'referral_linked'
  | 'referral_reward';

/** Money formatting used in every notification copy ($X.YZ). */
export function fmtMoney(cents: number): string {
  if (!Number.isFinite(cents) || cents < 0) return '0.00';
  return (Math.round(cents) / 100).toFixed(2);
}

/**
 * Static metadata per notification type: which channel to use and which app
 * route the client should open on tap. Kept as data so tests can pin the
 * contract (every type must map to a valid route + channel).
 */
export const NOTIFICATION_META: Record<NotificationType, { channel: string; route: string }> = {
  ride_accepted: { channel: 'ride', route: '/trip' },
  driver_arrived: { channel: 'ride', route: '/trip' },
  ride_started: { channel: 'ride', route: '/trip' },
  ride_completed: { channel: 'ride', route: '/trip' },
  ride_cancelled: { channel: 'ride', route: '/' },
  promo_applied: { channel: 'promo', route: '/' },
  credits_applied: { channel: 'credits', route: '/' },
  wallet_charged: { channel: 'wallet', route: '/' },
  credits_earned: { channel: 'credits', route: '/credits' },
  referral_linked: { channel: 'referral', route: '/credits' },
  referral_reward: { channel: 'referral', route: '/credits' },
};

export interface NotifyArgs {
  userId: string;
  role: NotificationRole;
  type: NotificationType;
  title: string;
  body: string;
  /** JSON payload carried on the push (type/tripId/amounts/route...). */
  data?: Record<string, string>;
  /** Idempotency key. `null` → always record (used for anonymous rows). */
  eventId?: string | null;
  channelId?: string;
  sound?: string;
  /** App route the client should navigate to on tap. */
  route?: string;
  priority?: 'high' | 'normal';
}

export interface NotifyResult {
  recorded: boolean;
  pushed: number;
  duplicate: boolean;
}

/**
 * Record + deliver a notification. See module docs for the dedup contract.
 */
export async function notifyUser(args: NotifyArgs): Promise<NotifyResult> {
  const { userId, role, type, title, body } = args;
  const meta = NOTIFICATION_META[type];
  const data = { ...(args.data ?? {}), type, route: args.route ?? meta.route };

  let insertedId: string | null = null;
  try {
    if (args.eventId) {
      const res = await pool.query(
        `INSERT INTO notifications (user_id, role, type, title, body, data, event_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING id`,
        [userId, role, type, title, body, JSON.stringify(data), args.eventId]
      );
      insertedId = res.rows[0]?.id ?? null;
    } else {
      const res = await pool.query(
        `INSERT INTO notifications (user_id, role, type, title, body, data)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING id`,
        [userId, role, type, title, body, JSON.stringify(data)]
      );
      insertedId = res.rows[0]?.id ?? null;
    }
  } catch (err) {
    logger.error({ err, userId, type, eventId: args.eventId }, '[NOTIF] Failed to record notification');
    return { recorded: false, pushed: 0, duplicate: false };
  }

  // Dedup: the event was already recorded by another worker → do NOT push.
  if (args.eventId && !insertedId) {
    logger.debug({ userId, type, eventId: args.eventId }, '[NOTIF] Duplicate event — skipping push');
    return { recorded: false, pushed: 0, duplicate: true };
  }

  const pushPayload: PushPayload = {
    title,
    body,
    data,
    channelId: args.channelId ?? meta.channel,
    sound: args.sound ?? 'default',
    priority: args.priority ?? 'high',
  };

  // Live socket emit first (fast path for the open app), then FCM fan-out
  // for every device (covers backgrounded/killed processes).
  let pushed = 0;
  try {
    io.to(`${role}:${userId}`).emit('notificationReceived', {
      id: insertedId,
      userId,
      role,
      type,
      title,
      body,
      data,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn({ err }, '[NOTIF] Socket emit failed (non-fatal)');
  }

  try {
    pushed = await sendPushAll(userId, role, pushPayload);
  } catch (err) {
    logger.warn({ err, userId, type }, '[NOTIF] Push delivery failed (non-fatal)');
  }

  return { recorded: true, pushed, duplicate: false };
}

// ===========================================================================
// Typed event helpers — ONE per real platform event.
// ===========================================================================
// Each helper is called exactly at the moment the backend processes its
// event and carries the event's real data (driver name, fare, amounts).
// The eventId is derived from permanent entity ids, so the notification is
// deduplicated across retries, restarts and multi-instance fan-out.

/** Live title/body copy for the "your driver accepted" push. */
export async function notifyRideAccepted(
  riderId: string,
  tripId: string,
  driverName: string,
  fareCents: number
): Promise<NotifyResult> {
  return notifyUser({
    userId: riderId,
    role: 'rider',
    type: 'ride_accepted',
    title: 'Your driver is on the way!',
    body: `${driverName} accepted your ride — fare $${fmtMoney(fareCents)}. Head to your pickup point.`,
    data: { tripId, driverName, fareCents: String(fareCents) },
    eventId: `ride:accepted:${tripId}`,
    sound: 'ride_accepted.wav',
  });
}

/** Driver entered the pickup grace zone. Guarded + deduped per trip. */
export async function notifyDriverArrived(
  riderId: string,
  tripId: string,
  driverName: string
): Promise<NotifyResult> {
  // Cheap short-circuit so the worker only hits the DB once per trip.
  const guard = `notif:arrived:${tripId}`;
  const seen = await redis.set(guard, '1', 'EX', 86400, 'NX');
  if (!seen) return { recorded: false, pushed: 0, duplicate: true };

  // Resolve the assigned driver's real display name for the copy.
  let name = driverName;
  try {
    const res = await pool.query(
      `SELECT u.full_name FROM rides r
       JOIN users u ON u.id = r.driver_id
       WHERE r.id = $1`,
      [tripId]
    );
    if (res.rows[0]?.full_name) name = res.rows[0].full_name;
  } catch {
    // Fall back to the caller-provided name.
  }

  return notifyUser({
    userId: riderId,
    role: 'rider',
    type: 'driver_arrived',
    title: 'Your driver has arrived',
    body: `${name} is waiting at your pickup location.`,
    data: { tripId, driverName: name },
    eventId: `ride:arrived:${tripId}`,
    sound: 'ride_accepted.wav',
  });
}

export async function notifyRideStarted(
  riderId: string,
  tripId: string,
  driverName: string
): Promise<NotifyResult> {
  return notifyUser({
    userId: riderId,
    role: 'rider',
    type: 'ride_started',
    title: 'Your trip has started',
    body: `${driverName} picked you up. Enjoy the ride!`,
    data: { tripId, driverName },
    eventId: `ride:started:${tripId}`,
    sound: 'trip_started.wav',
  });
}

export async function notifyRideCompleted(
  riderId: string,
  tripId: string,
  fareCents: number
): Promise<NotifyResult> {
  return notifyUser({
    userId: riderId,
    role: 'rider',
    type: 'ride_completed',
    title: 'Ride complete',
    body: `Your fare was $${fmtMoney(fareCents)}. Please rate your driver!`,
    data: { tripId, fareCents: String(fareCents) },
    eventId: `ride:completed:${tripId}`,
    sound: 'trip_completed.wav',
  });
}

/** The other party ended the ride. Recipient hears who did it. */
export async function notifyRideCancelled(
  recipientId: string,
  role: NotificationRole,
  tripId: string,
  actorRole: 'rider' | 'driver'
): Promise<NotifyResult> {
  const isRider = role === 'rider';
  return notifyUser({
    userId: recipientId,
    role,
    type: 'ride_cancelled',
    title: isRider ? 'Your driver cancelled' : 'Ride cancelled',
    body: isRider
      ? 'Your driver cancelled this ride. We\'re finding you a new driver.'
      : 'The rider cancelled this ride. You can accept the next request.',
    data: { tripId, actorRole },
    eventId: `ride:cancelled:${tripId}`,
    sound: 'order_cancelled.wav',
  });
}

/** Real money movement — ride credits earned (referral rewards etc.). */
export async function notifyCreditsEarned(
  riderId: string,
  amountCents: number,
  reason: string,
  eventKey: string
): Promise<NotifyResult> {
  return notifyUser({
    userId: riderId,
    role: 'rider',
    type: 'credits_earned',
    title: 'Ride credits added',
    body: `You earned $${fmtMoney(amountCents)} in ride credits — ${reason}`,
    data: { amountCents: String(amountCents), reason },
    eventId: `credits:earned:${eventKey}`,
  });
}

export async function notifyCreditsApplied(
  riderId: string,
  amountCents: number,
  rideId: string
): Promise<NotifyResult> {
  return notifyUser({
    userId: riderId,
    role: 'rider',
    type: 'credits_applied',
    title: 'Ride credits applied',
    body: `$${fmtMoney(amountCents)} of ride credits were applied to your ride`,
    data: { amountCents: String(amountCents), rideId },
    eventId: `credits:applied:${rideId}`,
  });
}

export async function notifyWalletCharged(
  riderId: string,
  amountCents: number,
  rideId: string
): Promise<NotifyResult> {
  return notifyUser({
    userId: riderId,
    role: 'rider',
    type: 'wallet_charged',
    title: 'Wallet payment',
    body: `$${fmtMoney(amountCents)} was paid from your wallet`,
    data: { amountCents: String(amountCents), rideId },
    eventId: `wallet:charged:${rideId}`,
  });
}

export async function notifyPromoApplied(
  riderId: string,
  code: string,
  discountCents: number,
  rideId: string
): Promise<NotifyResult> {
  return notifyUser({
    userId: riderId,
    role: 'rider',
    type: 'promo_applied',
    title: 'Promo applied',
    body: `${code} saved you $${fmtMoney(discountCents)} on this ride`,
    data: { code, discountCents: String(discountCents), rideId },
    eventId: `promo:applied:${rideId}:${code}`,
  });
}

export async function notifyReferralLinked(
  riderId: string,
  friendName: string | null,
  relationshipId: string
): Promise<NotifyResult> {
  return notifyUser({
    userId: riderId,
    role: 'rider',
    type: 'referral_linked',
    title: 'You have a new referral!',
    body: `${friendName ?? 'A friend'} joined with your referral code. You'll earn ride credits when they complete their first ride.`,
    data: { relationshipId },
    eventId: `referral:linked:${relationshipId}`,
  });
}

export async function notifyReferralRewardGranted(
  userId: string,
  amountCents: number,
  side: 'referrer' | 'referred',
  relationshipId: string
): Promise<NotifyResult> {
  const body =
    side === 'referrer'
      ? `A friend completed their first ride — you earned $${fmtMoney(amountCents)} in ride credits!`
      : `Welcome to NetRide! You earned $${fmtMoney(amountCents)} in ride credits for your first ride.`;
  return notifyUser({
    userId,
    role: 'rider',
    type: 'referral_reward',
    title: 'Referral reward earned',
    body,
    data: { amountCents: String(amountCents), side, relationshipId },
    eventId: `referral:reward:${relationshipId}:${side}`,
  });
}

// ===========================================================================
// In-app history feed
// ===========================================================================

export interface NotificationRow {
  id: string;
  user_id: string;
  role: string;
  type: string;
  title: string;
  body: string;
  data: any;
  read_at: string | null;
  created_at: string;
}

export async function listNotifications(
  userId: string,
  role: NotificationRole,
  limit = 50
): Promise<NotificationRow[]> {
  const res = await pool.query(
    `SELECT id, user_id, role, type, title, body, data, read_at, created_at
     FROM notifications
     WHERE user_id = $1 AND role = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [userId, role, Math.min(Math.max(limit, 1), 100)]
  );
  return res.rows as NotificationRow[];
}

export async function markNotificationsRead(
  userId: string,
  ids: string[]
): Promise<number> {
  if (ids.length === 0) return 0;
  const res = await pool.query(
    `UPDATE notifications SET read_at = NOW()
     WHERE user_id = $1 AND id = ANY($2::uuid[])
       AND read_at IS NULL`,
    [userId, ids]
  );
  return res.rowCount ?? 0;
}

export async function unreadNotificationCount(
  userId: string,
  role: NotificationRole
): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS n FROM notifications
     WHERE user_id = $1 AND role = $2 AND read_at IS NULL`,
    [userId, role]
  );
  return res.rows[0]?.n ?? 0;
}