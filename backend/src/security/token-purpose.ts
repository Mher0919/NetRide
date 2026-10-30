// backend/src/security/token-purpose.ts
//
// Token-purpose separation. All session tokens are HS256 JWTs signed with the
// same secret, so a valid signature alone does not prove the token was minted
// for API/socket authentication. Trusted-device and file-access tokens are
// deliberately short-lived, narrowly-scoped credentials and MUST NOT be
// accepted as general session credentials.
//
// Tokens issued before this discriminator existed have no `t` claim; they are
// grandfathered as session tokens so deployment does not log every user out.
// Every newly minted session token carries `t: "access"`.

export const SESSION_TOKEN_TYPE = 'access';

export function isSessionAccessToken(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const type = (payload as { t?: unknown }).t;
  return type === undefined || type === SESSION_TOKEN_TYPE;
}
