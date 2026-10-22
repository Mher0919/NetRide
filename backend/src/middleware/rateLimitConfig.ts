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
  'GET /api/app/version': {
    ip: { max: 120, windowMs: MINUTE },
  },
  'GET /api/admin/app-updates': {
    user: { max: 60, windowMs: MINUTE },
    ip: { max: 120, windowMs: MINUTE },
  },
  'GET /api/admin/app-updates/:app/:platform': {
    user: { max: 60, windowMs: MINUTE },
    ip: { max: 120, windowMs: MINUTE },
  },
  'GET /api/admin/app-updates/:app/:platform/history': {
    user: { max: 60, windowMs: MINUTE },
    ip: { max: 120, windowMs: MINUTE },
  },
  'PUT /api/admin/app-updates/:app/:platform/draft': {
    user: { max: 30, windowMs: MINUTE },
    ip: { max: 60, windowMs: MINUTE },
  },
  'DELETE /api/admin/app-updates/:app/:platform/draft': {
    user: { max: 20, windowMs: MINUTE },
    ip: { max: 40, windowMs: MINUTE },
  },
  'POST /api/admin/app-updates/:app/:platform/publish': {
    user: { max: 10, windowMs: MINUTE },
    ip: { max: 20, windowMs: MINUTE },
  },
  'POST /api/admin/app-updates/:app/:platform/deactivate': {
    user: { max: 10, windowMs: MINUTE },
    ip: { max: 20, windowMs: MINUTE },
  },

  // Authentication endpoints — strict limits. Keys MUST match the mounted
  // route paths (authRoutes mounted at /api/auth) or they never apply.
  'POST /api/auth/signup-password': {
    ip: { max: 10, windowMs: HOUR },
  },
  'POST /api/auth/login-password': {
    ip: { max: 20, windowMs: MINUTE },
  },
  'POST /api/auth/oauth': {
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
  // Credential-change endpoints: strict, per-user (they regroup sensitive
  // material and must never be a password-guessing oracle).
  'POST /api/auth/change-password': {
    user: { max: 10, windowMs: HOUR },
    ip: { max: 20, windowMs: HOUR },
  },
  'POST /api/auth/request-password-change': {
    user: { max: 5, windowMs: HOUR },
    ip: { max: 10, windowMs: HOUR },
  },
  // Phone verification: protects the Twilio/SMS quota and the phone
  // verification oracle.
  'POST /api/auth/request-phone-otp': {
    user: { max: 5, windowMs: HOUR },
    ip: { max: 10, windowMs: HOUR },
  },
  'POST /api/auth/verify-phone-otp': {
    user: { max: 10, windowMs: MINUTE },
    ip: { max: 20, windowMs: MINUTE },
  },

  // Admin 2FA — strict limits (6-digit code = 900k possibilities; an
  // online attacker must never get anywhere near a brute-force budget).
  'POST /api/auth/admin/request-2fa': {
    ip: { max: 5, windowMs: MINUTE },
  },
  'POST /api/auth/admin/verify-2fa': {
    ip: { max: 5, windowMs: MINUTE },
  },

  // Unified portal (Colab) auth — strict limits (anti-brute-force)
  'POST /api/portal/auth/login': {
    ip: { max: 10, windowMs: MINUTE },
  },
  'POST /api/portal/auth/verify-2fa': {
    ip: { max: 5, windowMs: MINUTE },
  },
  'POST /api/portal/auth/forgot-password': {
    ip: { max: 3, windowMs: MINUTE },
  },
  'POST /api/portal/auth/verify-reset-otp': {
    ip: { max: 5, windowMs: MINUTE },
  },
  'POST /api/portal/auth/reset-password': {
    ip: { max: 3, windowMs: MINUTE },
  },
  'POST /api/portal/auth/refresh': {
    ip: { max: 60, windowMs: MINUTE },
  },
  'POST /api/portal/auth/change-password': {
    user: { max: 10, windowMs: HOUR },
    ip: { max: 20, windowMs: HOUR },
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
  'POST /api/ride/cancel': {
    user: { max: 30, windowMs: MINUTE },
    ip: { max: 100, windowMs: MINUTE },
  },
  'POST /api/ride/accept': {
    user: { max: 60, windowMs: MINUTE },
    ip: { max: 120, windowMs: MINUTE },
  },
  'POST /api/ride/decline': {
    user: { max: 60, windowMs: MINUTE },
    ip: { max: 120, windowMs: MINUTE },
  },
  // Ride features (tip / test completion) — strict; they must never be a
  // spam or state-machine abuse vector.
  'POST /api/ride/:rideId/tip': {
    user: { max: 10, windowMs: HOUR },
    ip: { max: 20, windowMs: HOUR },
  },
  'POST /api/ride/:rideId/complete-test': {
    user: { max: 10, windowMs: HOUR },
    ip: { max: 20, windowMs: HOUR },
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

  // Payments (Stripe) — abuse prevention on money endpoints
  'POST /api/payments/setup-session': {
    user: { max: 10, windowMs: HOUR },
    ip: { max: 30, windowMs: HOUR },
  },
  'POST /api/payments/wallet/topup-session': {
    user: { max: 20, windowMs: HOUR },
    ip: { max: 60, windowMs: HOUR },
  },
  'POST /api/payments/consent': {
    user: { max: 10, windowMs: HOUR },
    ip: { max: 30, windowMs: HOUR },
  },
  'GET /api/payments/methods': {
    user: { max: 60, windowMs: MINUTE },
  },
  'DELETE /api/payments/methods/:id': {
    user: { max: 10, windowMs: HOUR },
    ip: { max: 30, windowMs: HOUR },
  },
  'POST /api/payments/connect/onboarding': {
    user: { max: 10, windowMs: HOUR },
    ip: { max: 30, windowMs: HOUR },
  },
  // Sponsor code validation — strict (6-digit secret; anti-brute-force).
  'POST /api/sponsor/validations/validate': {
    user: { max: 10, windowMs: MINUTE },
    ip: { max: 30, windowMs: MINUTE },
  },
  // Sponsor budget funding
  'POST /api/sponsor/funding/session': {
    user: { max: 10, windowMs: HOUR },
    ip: { max: 30, windowMs: HOUR },
  },
  'POST /api/sponsor/payment-method/card-setup-session': {
    user: { max: 10, windowMs: HOUR },
    ip: { max: 30, windowMs: HOUR },
  },
  'POST /api/sponsor/withdrawals/request': {
    user: { max: 5, windowMs: HOUR },
    ip: { max: 10, windowMs: HOUR },
  },
  // Admin financial actions
  'POST /api/admin/payments/:id/reconcile': {
    user: { max: 60, windowMs: MINUTE },
    ip: { max: 120, windowMs: MINUTE },
  },
  'POST /api/admin/payments/:id/refund': {
    user: { max: 20, windowMs: HOUR },
    ip: { max: 40, windowMs: HOUR },
  },
  'POST /api/admin/payments/rides/:rideId/retry-additional-charge': {
    user: { max: 30, windowMs: HOUR },
    ip: { max: 60, windowMs: HOUR },
  },
  'POST /api/admin/payments/payouts/:payoutId/transfer': {
    user: { max: 60, windowMs: HOUR },
    ip: { max: 120, windowMs: HOUR },
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
