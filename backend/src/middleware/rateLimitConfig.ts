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
  'POST /api/auth/signup': {
    ip: { max: 10, windowMs: HOUR },
  },
  'POST /api/auth/login': {
    ip: { max: 20, windowMs: MINUTE },
  },
  'POST /api/auth/verify-otp': {
    ip: { max: 10, windowMs: MINUTE },
  },
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
  'POST /api/upload': {
    user: { max: 60, windowMs: MINUTE },
    ip: { max: 100, windowMs: MINUTE },
  },
};

export const DEFAULT_USER_LIMIT: RateLimitRule = { max: 100, windowMs: MINUTE };
export const DEFAULT_IP_LIMIT: RateLimitRule = { max: 100, windowMs: MINUTE };

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
