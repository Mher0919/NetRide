import { v4 as uuidv4 } from 'uuid';
import { redis } from '../config/redis';
import { env } from '../config/env';

export enum OfferStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
  SUPERSEDED = 'SUPERSEDED',
}

export interface DriverOffer {
  offerId: string;
  rideId: string;
  driverId: string;
  status: OfferStatus;
  sentAt: string;
  respondedAt?: string;
  expiresAt: string;
  /**
   * The exact least-privilege `newTripRequest` payload computed at offer
   * creation. Persisted so the offer can be re-emitted verbatim when the
   * driver's socket reconnects (or when the app returns through the icon)
   * without recomputing prices or drifting from what was originally shown.
   */
  payload?: Record<string, unknown>;
}

const OFFER_RIDE_PREFIX = 'ride:offer:';
const OFFER_DRIVER_PREFIX = 'driver:offer:';
const OFFER_DATA_PREFIX = 'offer:data:';

export class DriverOfferService {
  /**
   * Create a new driver offer atomically — only succeeds if the driver
   * does not already have an active offer.
   *
   * Returns the offer if created, or null if the driver already has an
   * active offer (prevents double-dispatch).
   */
  static async createOffer(rideId: string, driverId: string): Promise<DriverOffer | null> {
    const lockKey = `${OFFER_DRIVER_PREFIX}${driverId}`;
    const locked = await redis.set(lockKey, rideId, 'EX', env.DRIVER_LOCK_TTL_S, 'NX');
    if (!locked) return null;

    const offerId = uuidv4();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + env.DRIVER_OFFER_TIMEOUT_MS);

    const offer: DriverOffer = {
      offerId,
      rideId,
      driverId,
      status: OfferStatus.SENT,
      sentAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    await redis.pipeline()
      .set(`${OFFER_DATA_PREFIX}${offerId}`, JSON.stringify(offer), 'EX', env.DRIVER_LOCK_TTL_S)
      .set(`${OFFER_RIDE_PREFIX}${rideId}`, offerId, 'EX', env.DRIVER_LOCK_TTL_S)
      .exec();

    return offer;
  }

  /**
   * Get the current offer for a ride (if any).
   */
  static async getOfferForRide(rideId: string): Promise<DriverOffer | null> {
    const offerId = await redis.get(`${OFFER_RIDE_PREFIX}${rideId}`);
    if (!offerId) return null;
    return DriverOfferService.getOffer(offerId);
  }

  /**
   * Get a specific offer by ID.
   */
  static async getOffer(offerId: string): Promise<DriverOffer | null> {
    const raw = await redis.get(`${OFFER_DATA_PREFIX}${offerId}`);
    if (!raw) return null;
    return JSON.parse(raw) as DriverOffer;
  }

  /**
   * The driver's current offer, if any. Reads the driver→ride lock first
   * and then the ride→offer pointer, so a released driver (decline /
   * timeout / offline) correctly reports no offer.
   */
  static async getOfferForDriver(driverId: string): Promise<DriverOffer | null> {
    const rideId = await redis.get(`${OFFER_DRIVER_PREFIX}${driverId}`);
    if (!rideId) return null;
    return DriverOfferService.getOfferForRide(rideId);
  }

  /**
   * Attach the rendered offer payload for later re-emission. Best-effort:
   * a missing payload only means a reconnect cannot replay the card, never
   * that the offer itself is invalid.
   */
  static async attachPayload(
    offerId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const offer = await DriverOfferService.getOffer(offerId);
    if (!offer) return;
    offer.payload = payload;
    const ttl = await redis.ttl(`${OFFER_DATA_PREFIX}${offerId}`);
    await redis.set(
      `${OFFER_DATA_PREFIX}${offerId}`,
      JSON.stringify(offer),
      'EX',
      ttl > 0 ? ttl : env.DRIVER_LOCK_TTL_S,
    );
  }

  /**
   * Transition an offer to a new state atomically.
   * Only succeeds if the offer is in the expected current state.
   * Prevents stale transitions.
   */
  static async transitionOffer(
    offerId: string,
    expectedStatus: OfferStatus,
    newStatus: OfferStatus,
  ): Promise<boolean> {
    const raw = await redis.get(`${OFFER_DATA_PREFIX}${offerId}`);
    if (!raw) return false;

    const offer = JSON.parse(raw) as DriverOffer;
    if (offer.status !== expectedStatus) return false;

    offer.status = newStatus;
    offer.respondedAt = new Date().toISOString();

    await redis.set(
      `${OFFER_DATA_PREFIX}${offerId}`,
      JSON.stringify(offer),
      'EX',
      env.DRIVER_LOCK_TTL_S,
    );

    return true;
  }

  /**
   * Accept an offer — atomically validates the offer is still valid and
   * marks it as accepted. Returns the updated offer on success, null if
   * the offer is no longer valid.
   */
  static async acceptOffer(offerId: string): Promise<DriverOffer | null> {
    const raw = await redis.get(`${OFFER_DATA_PREFIX}${offerId}`);
    if (!raw) return null;

    const offer = JSON.parse(raw) as DriverOffer;

    if (offer.status !== OfferStatus.SENT) return null;

    const now = Date.now();
    const expiresAt = new Date(offer.expiresAt).getTime();
    if (now > expiresAt) {
      await DriverOfferService.transitionOffer(
        offerId, OfferStatus.SENT, OfferStatus.EXPIRED,
      );
      return null;
    }

    const accepted = await DriverOfferService.transitionOffer(
      offerId, OfferStatus.SENT, OfferStatus.ACCEPTED,
    );
    if (!accepted) return null;

    return DriverOfferService.getOffer(offerId);
  }

  /**
   * Decline an offer. Returns true if the decline was processed.
   */
  static async declineOffer(offerId: string): Promise<boolean> {
    return DriverOfferService.transitionOffer(
      offerId, OfferStatus.SENT, OfferStatus.DECLINED,
    );
  }

  /**
   * Release the driver lock — cleans up the driver:offer key so the
   * driver can receive future offers. Called after decline, timeout,
   * or cancellation.
   */
  static async releaseDriver(driverId: string): Promise<void> {
    await redis.del(`${OFFER_DRIVER_PREFIX}${driverId}`);
  }

  /**
   * Cancel all offers for a ride — used when the rider cancels the
   * ride request. Releases the driver and cleans up.
   */
  static async cancelRideOffers(rideId: string): Promise<string | null> {
    const offer = await DriverOfferService.getOfferForRide(rideId);
    if (!offer) return null;

    await DriverOfferService.transitionOffer(
      offer.offerId, OfferStatus.SENT, OfferStatus.CANCELLED,
    );
    await DriverOfferService.releaseDriver(offer.driverId);
    await redis.del(`${OFFER_RIDE_PREFIX}${rideId}`);

    return offer.driverId;
  }

  /**
   * Supersede an existing offer (e.g., driver accepted but was preempted
   * by another driver who accepted first). Releases the driver.
   */
  static async supersedeOffer(offerId: string): Promise<void> {
    const raw = await redis.get(`${OFFER_DATA_PREFIX}${offerId}`);
    if (!raw) return;

    const offer = JSON.parse(raw) as DriverOffer;
    await DriverOfferService.transitionOffer(
      offerId, offer.status, OfferStatus.SUPERSEDED,
    );
    await DriverOfferService.releaseDriver(offer.driverId);
  }

  /**
   * Check if a driver currently has an active offer.
   */
  static async driverHasActiveOffer(driverId: string): Promise<boolean> {
    const key = await redis.get(`${OFFER_DRIVER_PREFIX}${driverId}`);
    return key !== null;
  }
}
