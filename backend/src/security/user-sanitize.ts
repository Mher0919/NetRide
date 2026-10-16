// backend/src/security/user-sanitize.ts
//
// Authentication responses previously returned `SELECT *` user rows, which
// included `password_hash` (bcrypt), `fcm_token` and other internal fields.
// Every response that embeds a user row must pass through this allowlist
// filter instead.

const SENSITIVE_USER_FIELDS = [
  'password_hash',
  'fcm_token',
  'face_enrollment_url',
  'reset_token',
  'email_verification_token',
  'trusted_device_token',
] as const;

export function sanitizeUser<T extends Record<string, any> | null | undefined>(user: T): T {
  if (!user || typeof user !== 'object') return user;
  const clone: Record<string, any> = { ...(user as Record<string, any>) };
  for (const field of SENSITIVE_USER_FIELDS) {
    if (field in clone) delete clone[field];
  }
  return clone as T;
}
