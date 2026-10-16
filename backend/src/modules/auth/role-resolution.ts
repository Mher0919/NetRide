// backend/src/modules/auth/role-resolution.ts
//
// Pure role-resolution helpers for session minting. Extracted so the
// privilege-escalation rules are unit-testable without a database.
//
// SECURITY CONTRACT:
//   * ADMIN can ONLY ever come from the authoritative `users.role` column.
//     A client-supplied hint (app_role / socket handshake role / OAuth body)
//     must never elevate a non-admin account.
//   * Public signup/OTP/OAuth self-registration may only ever create RIDER or
//     DRIVER accounts. PARTNER / FLEET / ADMIN accounts are provisioned by
//     administrators, never by the signup surface.

export type SessionRole = 'RIDER' | 'DRIVER' | 'ADMIN';

export function resolveSessionRole(
  dbRole: string | null | undefined,
  hasDriverProfile: boolean,
  appRoleHint?: string | null,
): SessionRole {
  const authoritativeRole = (dbRole ?? '').toString().trim().toUpperCase();
  if (authoritativeRole === 'ADMIN') return 'ADMIN';

  const hint = (appRoleHint ?? '').toString().trim().toUpperCase();
  if (hint === 'DRIVER' && hasDriverProfile) return 'DRIVER';
  return 'RIDER';
}

export function assertPublicSignupRole(raw: unknown): 'RIDER' | 'DRIVER' {
  const value = (raw ?? '').toString().trim().toUpperCase();
  if (value === 'RIDER' || value === 'DRIVER') return value;
  throw new Error('Invalid account role');
}
