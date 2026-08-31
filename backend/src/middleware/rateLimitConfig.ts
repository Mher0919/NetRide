export interface RateLimitRule {
  max: number;
  windowMs: number;
}

export interface RateLimitEntry {
  user?: RateLimitRule;
  ip?: RateLimitRule;
}

const MINUTE = 60 * 1000;
const HOUR = 3600 * 1000;

export const RATE_LIMITS: Record<string, RateLimitEntry> = {
  // Authentication endpoints — strict limits
  'POST /api/auth/signup': {
    ip: { max: 10, windowMs: HOUR },
  },
  'POST /api/auth/login': {
    ip: { max: 20, windowMs: MINUTE },
  },
  'POST /api/auth/verify-otp': {
    ip: { max: 10, windowMs: MINUTE },
  },
  'POST /api/auth/request-otp': {
    ip: { max: 10, windowMs: MINUTE },
  },
  'POST /api/auth/forgot-password': {
    ip: { max: 5, windowMs: MINUTE },
  },
  'POST /api/auth/reset-password': {
    ip: { max: 5, windowMs: MINUTE },
  },

  // Sponsor portal auth — strict limits (anti-brute-force)
  'POST /api/sponsor/auth/login': {
    ip: { max: 10, windowMs: MINUTE },
  },
  'POST /api/sponsor/auth/forgot-password': {
    ip: { max: 3, windowMs: MINUTE },
  },
  'POST /api/sponsor/auth/verify-reset-otp': {
    ip: { max: 5, windowMs: MINUTE },
  },
  'POST /api/sponsor/auth/reset-password': {
    ip: { max: 3, windowMs: MINUTE },
  },

  // Ride endpoints — moderate limits
  'POST /api/ride/request': {
    user: { max: 30, windowMs: MINUTE },
    ip: { max: 100, windowMs: MINUTE },
  },
  'POST /api/ride/estimate': {
    user: { max: 60, windowMs: MINUTE },
    ip: { max: 100, windowMs: MINUTE },
  },
  'POST /api/ride/:id/cancel': {
    user: { max: 30, windowMs: MINUTE },
    ip: { max: 100, windowMs: MINUTE },
  },
  'GET /api/ride/history': {
    user: { max: 60, windowMs: MINUTE },
  },

  // Upload endpoint — generous for legitimate usage, but not unlimited
  'POST /api/admin/users/:id/request-vehicle-resubmission': {
    user: { max: 30, windowMs: MINUTE },
    ip: { max: 60, windowMs: MINUTE },
  },
  'GET /api/driver/vehicles/resubmission-requirements': {
    user: { max: 30, windowMs: MINUTE },
    ip: { max: 60, windowMs: MINUTE },
  },
  'POST /api/driver/vehicles/submit-resubmission': {
    user: { max: 10, windowMs: MINUTE },
    ip: { max: 30, windowMs: MINUTE },
  },
  'POST /api/upload': {
    user: { max: 30, windowMs: MINUTE },
    ip: { max: 60, windowMs: MINUTE },
  },

  // Driver profile — authenticated users, higher limits
  'GET /api/driver/profile': {
    user: { max: 60, windowMs: MINUTE },
    ip: { max: 200, windowMs: MINUTE },
  },
  'PATCH /api/driver/profile': {
    user: { max: 30, windowMs: MINUTE },
    ip: { max: 60, windowMs: MINUTE },
  },
  'GET /api/driver/vehicles': {
    user: { max: 60, windowMs: MINUTE },
  },
  'GET /api/driver/vehicle-models/makes': {
    user: { max: 30, windowMs: MINUTE },
    ip: { max: 60, windowMs: MINUTE },
  },
  'GET /api/driver/vehicle-models/models': {
    user: { max: 30, windowMs: MINUTE },
    ip: { max: 60, windowMs: MINUTE },
  },
  'POST /api/driver/vehicles/submit': {
    user: { max: 10, windowMs: MINUTE },
    ip: { max: 30, windowMs: MINUTE },
  },
  'POST /api/driver/profile-changes': {
    user: { max: 5, windowMs: MINUTE },
    ip: { max: 10, windowMs: MINUTE },
  },

  // Admin endpoints — authenticated admins
  'GET /api/admin/users': {
    user: { max: 120, windowMs: MINUTE },
    ip: { max: 200, windowMs: MINUTE },
  },
  'GET /api/admin/users/:id': {
    user: { max: 120, windowMs: MINUTE },
    ip: { max: 200, windowMs: MINUTE },
  },
  'PATCH /api/admin/users/:id/verify': {
    user: { max: 60, windowMs: MINUTE },
    ip: { max: 120, windowMs: MINUTE },
  },
  'POST /api/admin/vehicles/submissions/:id/approve': {
    user: { max: 30, windowMs: MINUTE },
    ip: { max: 60, windowMs: MINUTE },
  },
  'POST /api/admin/vehicles/submissions/:id/reject': {
    user: { max: 30, windowMs: MINUTE },
    ip: { max: 60, windowMs: MINUTE },
  },
  'POST /api/admin/vehicles/submissions/:id/request-changes': {
    user: { max: 30, windowMs: MINUTE },
    ip: { max: 60, windowMs: MINUTE },
  },
  'POST /api/admin/users/:id/request-docs': {
    user: { max: 30, windowMs: MINUTE },
    ip: { max: 60, windowMs: MINUTE },
  },

  // Rewards ecosystem — strict anti-abuse limits
  'POST /api/referral/scan': {
    user: { max: 10, windowMs: HOUR },
    ip: { max: 30, windowMs: HOUR },
  },
  'POST /api/referral/skip': {
    user: { max: 10, windowMs: HOUR },
    ip: { max: 30, windowMs: HOUR },
  },
  'GET /api/referral/onboarding-status': {
    user: { max: 60, windowMs: MINUTE },
    ip: { max: 120, windowMs: MINUTE },
  },
  'POST /api/promo/validate': {
    user: { max: 60, windowMs: MINUTE },
    ip: { max: 120, windowMs: MINUTE },
  },
  'GET /api/credits': {
    user: { max: 60, windowMs: MINUTE },
  },
  'GET /api/referral': {
    user: { max: 60, windowMs: MINUTE },
  },
  'POST /api/admin/partners': {
    user: { max: 30, windowMs: MINUTE },
    ip: { max: 60, windowMs: MINUTE },
  },
  'POST /api/admin/credits/grant': {
    user: { max: 60, windowMs: MINUTE },
    ip: { max: 120, windowMs: MINUTE },
  },
};

export const DEFAULT_USER_LIMIT: RateLimitRule = { max: 100, windowMs: MINUTE };
export const DEFAULT_IP_LIMIT: RateLimitRule = { max: 60, windowMs: MINUTE };

export function matchRoute(path: string, method: string): string | null {
  const key = `${method} ${path}`;
  if (RATE_LIMITS[key]) return key;

  for (const pattern of Object.keys(RATE_LIMITS)) {
    const [pMethod, pPath] = pattern.split(' ');
    if (pMethod !== method) continue;
    const routeParts = pPath.split('/');
    const pathParts = path.split('/');
    if (routeParts.length !== pathParts.length) continue;
    let match = true;
    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) continue;
      if (routeParts[i] !== pathParts[i]) { match = false; break; }
    }
    if (match) return pattern;
  }

  return null;
}
