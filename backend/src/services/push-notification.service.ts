// backend/src/services/push-notification.service.ts
//
// Push notification service using Firebase Cloud Messaging (FCM).
// Sends notifications to users/drivers who are offline (app in background
// or killed) when they receive chat messages or incoming calls.
//
// If FCM credentials are not configured, notifications are logged instead
// of being sent — this allows development/testing to proceed without a
// Firebase project.

import { App, initializeApp, cert } from 'firebase-admin/app';
import { getMessaging, Message } from 'firebase-admin/messaging';
import { env } from '../config/env';
import { pool } from '../config/database';
import { redis } from '../config/redis';
import { logger } from '../observability/logger';
import { pushDeliveryTotal } from '../observability/metrics';
import * as fs from 'fs';

// ============================================
// Firebase initialization
// ============================================

let firebaseApp: App | null = null;
let fcmEnabled = false;

function initFirebase(): void {
  if (firebaseApp) return;

  let serviceAccount: any = null;

  // Prefer base64-encoded credential
  if (env.FCM_SERVICE_ACCOUNT_B64) {
    try {
      const json = Buffer.from(env.FCM_SERVICE_ACCOUNT_B64, 'base64').toString('utf-8');
      serviceAccount = JSON.parse(json);
      logger.info('[FCM] Initialized from FCM_SERVICE_ACCOUNT_B64');
    } catch (err) {
      logger.error({ err }, '[FCM] Failed to parse FCM_SERVICE_ACCOUNT_B64');
    }
  }

  // Fall back to file path
  if (!serviceAccount && env.FCM_SERVICE_ACCOUNT_PATH) {
    try {
      // The path is operator configuration, but require a regular file so a
      // misconfiguration can never point the read at a device/FIFO.
      const stat = fs.statSync(env.FCM_SERVICE_ACCOUNT_PATH);
      if (!stat.isFile()) {
        throw new Error('FCM service account path is not a regular file');
      }
      const raw = fs.readFileSync(env.FCM_SERVICE_ACCOUNT_PATH, 'utf-8');
      serviceAccount = JSON.parse(raw);
      logger.info({ path: env.FCM_SERVICE_ACCOUNT_PATH }, '[FCM] Initialized from service account file');
    } catch (err) {
      logger.error({ err, path: env.FCM_SERVICE_ACCOUNT_PATH }, '[FCM] Failed to read service account file');
    }
  }

  if (!serviceAccount) {
    logger.warn('[FCM] No service account configured. Push notifications will be logged but not sent.');
    fcmEnabled = false;
    return;
  }

  try {
    firebaseApp = initializeApp({
      credential: cert(serviceAccount),
    }, 'netride-fcm');
    fcmEnabled = true;
    logger.info('[FCM] Firebase Admin SDK initialized successfully');
  } catch (err) {
    logger.error({ err }, '[FCM] Failed to initialize Firebase Admin SDK');
    fcmEnabled = false;
  }
}

// Initialize lazily on first use
initFirebase();

// ============================================
// Token management
// ============================================

/**
 * Store a user's FCM token in the database.
 * Works for both riders (users table) and drivers (drivers table).
 *
 * Since 040, tokens live in the multi-device `device_tokens` registry so a
 * user can receive pushes on every phone they run the app on. The legacy
 * single-token columns (users.fcm_token / drivers.fcm_token) are kept in
 * sync for backward compatibility with the old delivery path.
 */
export async function storeFcmToken(
  userId: string,
  role: 'rider' | 'driver',
  token: string,
  meta?: { platform?: string; appVersion?: string }
): Promise<void> {
  if (!token || token.length < 10) return;

  await pool.query(
    `INSERT INTO device_tokens (user_id, role, token, platform, app_version)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (token)
     DO UPDATE SET user_id = EXCLUDED.user_id,
                   role = EXCLUDED.role,
                   platform = COALESCE(EXCLUDED.platform, device_tokens.platform),
                   app_version = COALESCE(EXCLUDED.app_version, device_tokens.app_version),
                   updated_at = NOW(),
                   last_used_at = NOW()`,
    [userId, role, token, meta?.platform ?? null, meta?.appVersion ?? null]
  );

  // Legacy single-column mirror. Best-effort: the multi-device registry is
  // the source of truth, and on databases where the optional column is
  // absent a mirror failure must not reject a token registration that
  // already succeeded (it previously returned 500 after a partial write).
  try {
    if (role === 'rider') {
      await pool.query(
        'UPDATE users SET fcm_token = $1, updated_at = NOW() WHERE id = $2',
        [token, userId]
      );
    } else {
      await pool.query(
        'UPDATE drivers SET fcm_token = $1 WHERE user_id = $2',
        [token, userId]
      );
    }
  } catch (err: any) {
    logger.warn({ err, userId, role }, '[FCM] Legacy token mirror failed (device registry still updated)');
  }
  logger.debug({ userId, role }, '[FCM] Token stored');
}

/**
 * All active FCM tokens for a user+role (multi-device fan-out).
 */
export async function getFcmTokens(
  userId: string,
  role: 'rider' | 'driver'
): Promise<string[]> {
  try {
    const res = await pool.query(
      `SELECT token FROM device_tokens
       WHERE user_id = $1 AND role = $2 AND token <> ''
       ORDER BY last_used_at DESC`,
      [userId, role]
    );
    const tokens = res.rows.map((r: any) => r.token as string);
    if (tokens.length > 0) return tokens;

    // Legacy fallback: single-column token from before 040.
    const legacy = await getFcmToken(userId, role);
    return legacy ? [legacy] : [];
  } catch (err) {
    logger.error({ err, userId, role }, '[FCM] Failed to fetch tokens');
    return [];
  }
}

/**
 * Retrieve a user's or driver's FCM token (legacy single-token read).
 */
export async function getFcmToken(
  userId: string,
  role: 'rider' | 'driver'
): Promise<string | null> {
  try {
    const query = role === 'rider'
      ? 'SELECT fcm_token FROM users WHERE id = $1'
      : 'SELECT fcm_token FROM drivers WHERE user_id = $1';
    const res = await pool.query(query, [userId]);
    return res.rows[0]?.fcm_token || null;
  } catch (err) {
    logger.error({ err, userId, role }, '[FCM] Failed to fetch token');
    return null;
  }
}

/**
 * Remove a user's FCM token(s).
 * - With `token`: removes only that device token (e.g. one phone logs out).
 * - Without `token`: removes every token for the user+role (full logout).
 */
export async function clearFcmToken(
  userId: string,
  role: 'rider' | 'driver',
  token?: string
): Promise<void> {
  if (token) {
    await pool.query(
      `DELETE FROM device_tokens WHERE user_id = $1 AND role = $2 AND token = $3`,
      [userId, role, token]
    );
    return;
  }
  await pool.query(
    `DELETE FROM device_tokens WHERE user_id = $1 AND role = $2`,
    [userId, role]
  );
  if (role === 'rider') {
    await pool.query('UPDATE users SET fcm_token = NULL WHERE id = $1', [userId]);
  } else {
    await pool.query('UPDATE drivers SET fcm_token = NULL WHERE user_id = $1', [userId]);
  }
  logger.debug({ userId, role }, '[FCM] Token cleared');
}

// ============================================
// Notification sending
// ============================================

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  priority?: 'high' | 'normal';
  channelId?: string;
  badge?: number;
  sound?: string;
}

/**
 * Send a push notification to a specific user/driver.
 * If the token is missing or FCM is not configured, logs the notification.
 */
export async function sendPush(
  userId: string,
  role: 'rider' | 'driver',
  payload: PushPayload
): Promise<boolean> {
  const token = await getFcmToken(userId, role);
  if (!token) {
    logger.debug({ userId, role, title: payload.title }, '[FCM] No token on record — skipping push');
    pushDeliveryTotal.inc({ outcome: 'no_tokens' });
    return false;
  }

  if (!fcmEnabled || !firebaseApp) {
    logger.info({
      userId,
      role,
      title: payload.title,
      body: payload.body,
      data: payload.data,
    }, '[FCM] (stub) Push notification not sent — FCM not configured');
    // Stub mode is NOT delivery: reporting success here previously made
    // telemetry claim pushes were sent when nothing left the process.
    pushDeliveryTotal.inc({ outcome: 'stub' });
    return false;
  }

  try {
    const message: Message = {
      token,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: payload.data || {},
      android: {
        priority: payload.priority || 'high',
        notification: {
          channelId: payload.channelId || 'default',
          sound: payload.sound || 'default',
          priority: 'high' as any,
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        payload: {
          aps: {
            badge: payload.badge,
            sound: payload.sound || 'default',
            'content-available': 1,
          },
        },
      },
    };

    const messaging = getMessaging(firebaseApp);
    const messageId = await messaging.send(message);
    logger.info({ userId, role, messageId, title: payload.title }, '[FCM] Push sent');
    pushDeliveryTotal.inc({ outcome: 'delivered' });
    return true;
  } catch (err: any) {
    if (err?.code === 'messaging/invalid-registration-token' ||
        err?.code === 'messaging/registration-token-not-registered') {
      // Clear ONLY the offending token. The previous blanket
      // `clearFcmToken(userId, role)` wiped every device the user owned
      // because one stale install failed, silently disabling all pushes.
      logger.warn({ userId, role, errCode: err.code }, '[FCM] Token invalid — pruning device');
      pushDeliveryTotal.inc({ outcome: 'invalid_token' });
      await clearFcmToken(userId, role, token);
    } else {
      logger.error({ err, userId, role }, '[FCM] Failed to send push');
      pushDeliveryTotal.inc({ outcome: 'failed' });
    }
    return false;
  }
}

/**
 * Fan-out a push to EVERY device token on record for the user+role.
 * Returns the number of devices that accepted the message. Invalid tokens
 * are pruned from the registry so a stale phone can't block later sends.
 */
export async function sendPushAll(
  userId: string,
  role: 'rider' | 'driver',
  payload: PushPayload
): Promise<number> {
  const tokens = await getFcmTokens(userId, role);
  if (tokens.length === 0) {
    logger.debug({ userId, role, title: payload.title }, '[FCM] No tokens on record — skipping push');
    pushDeliveryTotal.inc({ outcome: 'no_tokens' });
    return 0;
  }

  if (!fcmEnabled || !firebaseApp) {
    logger.info({
      userId,
      role,
      title: payload.title,
      body: payload.body,
      data: payload.data,
    }, '[FCM] (stub) Push notification not sent — FCM not configured');
    pushDeliveryTotal.inc({ outcome: 'stub' });
    return 0;
  }

  let delivered = 0;
  for (const token of tokens) {
    try {
      const message: Message = {
        token,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: payload.data || {},
        android: {
          priority: payload.priority || 'high',
          notification: {
            channelId: payload.channelId || 'default',
            sound: payload.sound || 'default',
            priority: 'high' as any,
            defaultSound: true,
            defaultVibrateTimings: true,
          },
        },
        apns: {
          payload: {
            aps: {
              badge: payload.badge,
              sound: payload.sound || 'default',
              'content-available': 1,
            },
          },
        },
      };

      const messaging = getMessaging(firebaseApp);
      const messageId = await messaging.send(message);
      delivered += 1;
      pushDeliveryTotal.inc({ outcome: 'delivered' });
      logger.info({ userId, role, messageId, title: payload.title }, '[FCM] Push sent (device fan-out)');
    } catch (err: any) {
      if (err?.code === 'messaging/invalid-registration-token' ||
          err?.code === 'messaging/registration-token-not-registered') {
        logger.warn({ userId, role, errCode: err.code }, '[FCM] Device token invalid — pruning');
        pushDeliveryTotal.inc({ outcome: 'invalid_token' });
        await pool.query(`DELETE FROM device_tokens WHERE user_id = $1 AND role = $2 AND token = $3`, [userId, role, token]).catch(() => undefined);
      } else {
        logger.error({ err, userId, role }, '[FCM] Device push failed');
        pushDeliveryTotal.inc({ outcome: 'failed' });
      }
    }
  }
  return delivered;
}

// ============================================
// Convenience helpers for common notification types
// ============================================

/**
 * Send a "new chat message" push notification.
 */
export async function pushChatMessage(
  recipientId: string,
  role: 'rider' | 'driver',
  senderName: string,
  messagePreview: string,
  tripId: string
): Promise<boolean> {
  const preview = messagePreview.length > 50
    ? messagePreview.substring(0, 47) + '...'
    : messagePreview;

  return sendPush(recipientId, role, {
    title: `New message from ${senderName}`,
    body: preview,
    data: {
      type: 'chat',
      tripId,
      senderName,
    },
    channelId: 'chat',
    sound: 'message.wav',
  });
}

/**
 * Send an "incoming call" push notification (high priority).
 */
export async function pushIncomingCall(
  recipientId: string,
  role: 'rider' | 'driver',
  callerName: string,
  tripId: string
): Promise<boolean> {
  return sendPush(recipientId, role, {
    title: `Incoming call from ${callerName}`,
    body: 'Tap to answer',
    data: {
      type: 'call',
      tripId,
      callerName,
    },
    priority: 'high',
    channelId: 'call',
    sound: 'ringtone.wav',
  });
}

/**
 * Send a "ride accepted" push notification (rider side).
 */
export async function pushRideAccepted(
  riderId: string,
  driverName: string,
  tripId: string
): Promise<boolean> {
  return sendPush(riderId, 'rider', {
    title: 'Your driver is on the way!',
    body: `${driverName} accepted your ride`,
    data: {
      type: 'ride_accepted',
      tripId,
      driverName,
    },
    channelId: 'ride',
    sound: 'ride_accepted.wav',
  });
}

export interface RideOfferPush {
  offerId: string;
  tripId: string;
  expiresAt: string;
  earningsCents?: number;
  pickupAddress?: string;
  riderName?: string;
}

/**
 * Send a "new ride offer" push notification (driver side).
 *
 * This is the ONLY delivery path for a driver whose app is backgrounded or
 * killed — the socket offer is invisible to them and the offer expires in
 * seconds. The payload carries the server-authoritative offer id and
 * expiry so notification actions can call the authenticated REST
 * accept/decline endpoints; the notification body itself is never treated
 * as state. Fan-out covers every registered device.
 */
export async function pushRideOffer(driverId: string, offer: RideOfferPush): Promise<number> {
  const body = offer.earningsCents != null
    ? `New ride available — estimated earnings $${(offer.earningsCents / 100).toFixed(2)}`
    : 'A new ride is available';
  return sendPushAll(driverId, 'driver', {
    title: 'New ride request',
    body,
    data: {
      type: 'ride_offer',
      tripId: offer.tripId,
      offerId: offer.offerId,
      expiresAt: offer.expiresAt,
      ...(offer.earningsCents != null ? { earningsCents: String(offer.earningsCents) } : {}),
      ...(offer.pickupAddress ? { pickupAddress: offer.pickupAddress } : {}),
    },
    priority: 'high',
    channelId: 'ride_offer',
    sound: 'ride_offer.wav',
  });
}

// ============================================
// 037: Credits / promo / referral notifications
// ============================================

/** Ride credits were added to the rider's balance. */
export async function pushCreditsEarned(
  riderId: string,
  amountCents: number,
  reason: string
): Promise<boolean> {
  return sendPush(riderId, 'rider', {
    title: 'Ride credits added',
    body: `You earned $${(amountCents / 100).toFixed(2)} in ride credits — ${reason}`,
    data: {
      type: 'credits_earned',
      amountCents: String(amountCents),
      reason,
    },
    channelId: 'credits',
  });
}

/** Credits were deducted for a ride. */
export async function pushCreditsApplied(
  riderId: string,
  amountCents: number,
  rideId: string
): Promise<boolean> {
  return sendPush(riderId, 'rider', {
    title: 'Ride credits applied',
    body: `$${(amountCents / 100).toFixed(2)} of ride credits were applied to your ride`,
    data: {
      type: 'credits_applied',
      amountCents: String(amountCents),
      rideId,
    },
    channelId: 'credits',
  });
}

/** The rider wallet was charged for a ride. */
export async function pushWalletCharged(
  riderId: string,
  amountCents: number,
  rideId: string
): Promise<boolean> {
  return sendPush(riderId, 'rider', {
    title: 'Wallet payment',
    body: `$${(amountCents / 100).toFixed(2)} was paid from your wallet`,
    data: {
      type: 'wallet_charged',
      amountCents: String(amountCents),
      rideId,
    },
    channelId: 'wallet',
  });
}

/** A promo code was accepted on a ride. */
export async function pushPromoAccepted(
  riderId: string,
  code: string,
  discountCents: number
): Promise<boolean> {
  return sendPush(riderId, 'rider', {
    title: 'Promo applied',
    body: `${code} saved you $${(discountCents / 100).toFixed(2)} on this ride`,
    data: {
      type: 'promo_accepted',
      code,
      discountCents: String(discountCents),
    },
    channelId: 'promo',
  });
}

/** A promo code was rejected during booking. */
export async function pushPromoRejected(
  riderId: string,
  code: string,
  reason: string
): Promise<boolean> {
  return sendPush(riderId, 'rider', {
    title: 'Promo not applied',
    body: `${code}: ${reason}`,
    data: {
      type: 'promo_rejected',
      code,
      reason,
    },
    channelId: 'promo',
  });
}

/** A friend scanned the rider's QR — referral relationship created. */
export async function pushReferralLinked(
  riderId: string,
  friendName: string | null
): Promise<boolean> {
  return sendPush(riderId, 'rider', {
    title: 'You have a new referral!',
    body: `${friendName ?? 'A friend'} joined with your referral code. You'll earn $5 when they complete their first ride.`,
    data: {
      type: 'referral_linked',
    },
    channelId: 'referral',
  });
}

/** $5 referral reward granted (either side). */
export async function pushReferralRewardGranted(
  userId: string,
  amountCents: number,
  side: 'referrer' | 'referred'
): Promise<boolean> {
  const body =
    side === 'referrer'
      ? `A friend completed their first ride — you earned $${(amountCents / 100).toFixed(2)} in ride credits!`
      : `Welcome to NetRide! You earned $${(amountCents / 100).toFixed(2)} in ride credits for your first ride.`;
  return sendPush(userId, 'rider', {
    title: 'Referral reward earned',
    body,
    data: {
      type: 'referral_reward',
      amountCents: String(amountCents),
      side,
    },
    channelId: 'referral',
  });
}

/**
 * Send a "ride completed" push notification (rider side).
 */
export async function pushRideCompleted(
  riderId: string,
  tripId: string,
  fare: string
): Promise<boolean> {
  return sendPush(riderId, 'rider', {
    title: 'Ride completed',
    body: `Your fare was $${fare}. Please rate your trip!`,
    data: {
      type: 'ride_completed',
      tripId,
      fare,
    },
    channelId: 'ride',
  });
}

// ============================================
// Online presence check (used by socket gateway)
// ============================================

const PRESENCE_KEY = (userId: string, role: string) => `presence:${role}:${userId}`;

// Presence = "this user has a live socket right now", used only to choose
// between socket delivery and FCM for chat/calls. The TTL is refreshed by
// the socket gateway while the connection is alive; without the refresh a
// connected user was considered offline after 60s and every message was
// pushed as well as socket-delivered (duplicate alerts).
const PRESENCE_TTL_S = 120;

/**
 * Mark a user as online (called when socket connects). The value is the
 * owning socket id so a stale socket's disconnect cannot wipe a newer
 * connection's presence.
 */
export async function markOnline(userId: string, role: 'rider' | 'driver', socketId: string): Promise<void> {
  const key = PRESENCE_KEY(userId, role);
  await redis.set(key, socketId, 'EX', PRESENCE_TTL_S);
}

/**
 * Refresh presence for a still-connected socket. Compare-and-expire: only
 * renews when this socket still owns the key, so a second device (or a
 * reconnect) is never resurrected by the old connection's timer.
 */
export async function touchPresence(userId: string, role: 'rider' | 'driver', socketId: string): Promise<void> {
  const key = PRESENCE_KEY(userId, role);
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('EXPIRE', KEYS[1], ARGV[2])
    end
    return 0
  `;
  await redis.eval(script, 1, key, socketId, String(PRESENCE_TTL_S));
}

/**
 * Mark a user as offline. With a socket id, only deletes when that socket
 * still owns the presence key (multi-device / reconnect safe); without
 * one, deletes unconditionally.
 */
export async function markOffline(
  userId: string,
  role: 'rider' | 'driver',
  socketId?: string,
): Promise<void> {
  const key = PRESENCE_KEY(userId, role);
  if (!socketId) {
    await redis.del(key);
    return;
  }
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;
  await redis.eval(script, 1, key, socketId);
}

/**
 * Check if a user is currently online (has an active socket connection).
 */
export async function isOnline(userId: string, role: 'rider' | 'driver'): Promise<boolean> {
  const key = PRESENCE_KEY(userId, role);
  const result = await redis.get(key);
  return !!result;
}

/**
 * Emit to a user via socket if online, OR send a push notification if offline.
 * Returns true if delivered via socket, false if push was used (or both failed).
 */
export async function deliverOrPush(
  io: any,
  recipientId: string,
  role: 'rider' | 'driver',
  event: string,
  payload: any,
  pushPayload: PushPayload
): Promise<'socket' | 'push' | 'none'> {
  const online = await isOnline(recipientId, role);
  let delivered: 'socket' | 'push' | 'none' = 'none';

  if (online) {
    // Emit to the room — even if the "online" key exists, they might
    // have just disconnected. We emit optimistically.
    io.to(`${role}:${recipientId}`).emit(event, payload);
    delivered = 'socket';
  } else {
    // User is offline — send push notification
    const sent = await sendPush(recipientId, role, pushPayload);
    delivered = sent ? 'push' : 'none';
  }

  return delivered;
}
