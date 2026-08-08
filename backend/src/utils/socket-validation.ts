// backend/src/utils/socket-validation.ts
//
// Socket event payload validation utilities.
// Ensures all socket events have proper structure before processing.

import { z } from 'zod';

// ============================================
// Shared schemas
// ============================================

export const CoordinateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const LocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().optional(),
});

export const LocationWithAddressSchema = LocationSchema.extend({
  address: z.string().min(1),
});

// ============================================
// Driver events
// ============================================

export const GoOnlineSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

export const UpdateLocationSchema = LocationSchema;

export const AcceptTripSchema = z.string().uuid();

export const DeclineTripSchema = z.string().uuid();

export const CancelTripSchema = z.string().uuid();

export const PickUpRiderSchema = z.string().uuid();

export const CompleteTripSchema = z.string().uuid();

export const SendMessageSchema = z.object({
  tripId: z.string().uuid(),
  message: z.string().min(1).max(1000),
});

export const RequestRerouteSchema = z.object({
  tripId: z.string().uuid(),
  leg: z.enum(['pickup', 'destination']),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

// ============================================
// Rider events
// ============================================

export const SubscribeNearbyDriversSchema = LocationSchema;

export const RiderUpdateLocationSchema = LocationSchema;

export const RequestRideSchema = z.object({
  pickup: LocationWithAddressSchema,
  destination: LocationWithAddressSchema,
  isScheduled: z.boolean().optional(),
  scheduledAt: z.string().datetime().optional(),
  favoritePriority: z.boolean().optional(),
  idempotencyKey: z.string().uuid().optional(),
  // Rewards ecosystem: promo code + "apply ride credits" opt-in + an optional
  // rider-chosen credit amount (cents). Validity is ALWAYS re-checked by the
  // backend — these are just client hints.
  promoCode: z.string().trim().min(2).max(32).optional(),
  applyCredits: z.boolean().optional(),
  creditUseCents: z.number().int().min(1).optional(),
});

export const RiderDestinationChangedSchema = z.object({
  tripId: z.string().uuid(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().min(1),
});

// ============================================
// Validation helper
// ============================================

export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export function validate<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  socket: any,
  eventName: string
): ValidationResult<T> {
  const result = schema.safeParse(data);
  
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    console.warn(`[SOCKET VALIDATION] ${eventName} failed: ${issues}`);
    socket.emit('error', `Invalid ${eventName} payload: ${issues}`);
    return { success: false, error: issues };
  }
  
  return { success: true, data: result.data };
}

// ============================================
// Rate limiting for high-frequency events
// ============================================

const RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  'updateLocation': { max: 60, windowMs: 60_000 }, // 60/min
  'sendMessage': { max: 30, windowMs: 60_000 },    // 30/min
  'requestReroute': { max: 10, windowMs: 60_000 }, // 10/min
};

export async function checkRateLimit(socket: any, eventName: string): Promise<boolean> {
  const limit = RATE_LIMITS[eventName];
  if (!limit) return true;
  
  const userId = (socket as any).user?.id || socket.id;
  const key = `ratelimit:sock:${eventName}:${userId}`;
  
  try {
    const { redis } = await import('../config/redis');
    const now = Date.now();
    const cutoff = now - limit.windowMs;
    
    // Clean old entries and count current
    const lua = `
      local cutoff = tonumber(ARGV[1])
      redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", cutoff)
      local count = redis.call("ZCARD", KEYS[1])
      if count >= tonumber(ARGV[2]) then
        return {0, count}
      end
      redis.call("ZADD", KEYS[1], ARGV[3], ARGV[4])
      redis.call("PEXPIRE", KEYS[1], ARGV[5])
      return {1, count + 1}
    `;
    
    const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
    const result = await redis.eval(lua, 1, key, String(cutoff), String(limit.max), member, String(limit.windowMs)) as [number, number];
    
    if (result[0] === 0) {
      console.warn(`[SOCKET RATE LIMIT] ${eventName} rate limited for user ${userId} (${result[1]}/${limit.max})`);
      socket.emit('error', `${eventName} rate limit exceeded. Please slow down.`);
      return false;
    }
    return true;
  } catch (err) {
    // On Redis error, allow request (fail open)
    console.error(`[SOCKET RATE LIMIT] Error checking rate limit for ${eventName}:`, err);
    return true;
  }
}