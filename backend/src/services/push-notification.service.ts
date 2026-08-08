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
 */
export async function storeFcmToken(
  userId: string,
  role: 'rider' | 'driver',
  token: string
): Promise<void> {
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
  logger.debug({ userId, role }, '[FCM] Token stored');
}

/**
 * Retrieve a user's or driver's FCM token.
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
 * Remove a user's FCM token (e.g. on logout).
 */
export async function clearFcmToken(
  userId: string,
  role: 'rider' | 'driver'
): Promise<void> {
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
    return true;
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
    return true;
  } catch (err: any) {
    if (err?.code === 'messaging/invalid-registration-token' ||
        err?.code === 'messaging/registration-token-not-registerred') {
      logger.warn({ userId, role, errCode: err.code }, '[FCM] Token invalid — clearing');
      await clearFcmToken(userId, role);
    } else {
      logger.error({ err, userId, role }, '[FCM] Failed to send push');
    }
    return false;
  }
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

/**
 * Send a "new ride offer" push notification (driver side).
 */
export async function pushRideOffer(
  driverId: string,
  tripId: string,
  fare: string
): Promise<boolean> {
  return sendPush(driverId, 'driver', {
    title: 'New ride request',
    body: `A new ride is available for $${fare}`,
    data: {
      type: 'ride_offer',
      tripId,
      fare,
    },
    priority: 'high',
    channelId: 'ride',
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

/**
 * Mark a user as online (called when socket connects).
 */
export async function markOnline(userId: string, role: 'rider' | 'driver', socketId: string): Promise<void> {
  const key = PRESENCE_KEY(userId, role);
  // Store socket ID with a 60s TTL (refreshed by heartbeat)
  await redis.set(key, socketId, 'EX', 60);
}

/**
 * Mark a user as offline (called when socket disconnects).
 */
export async function markOffline(userId: string, role: 'rider' | 'driver'): Promise<void> {
  const key = PRESENCE_KEY(userId, role);
  await redis.del(key);
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
