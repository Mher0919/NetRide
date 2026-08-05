// backend/src/services/qr-signature.service.ts
//
// Referral QR payload security.
// ---------------------------------------------------------------------------
// Payload format (dot-separated):
//
//   v1.<userId>.<code>.<expiryEpochSeconds>.<hmacHex>
//
// The HMAC is SHA-256 over "v1.<userId>.<code>.<expiryEpochSeconds>" keyed by
// REFERRAL_QR_SECRET. Verification is constant-time. Expiry + ownership
// binding (userId inside the payload MUST match the owner of `code` in the
// referral_codes table) makes replay and forgery attacks fail:
//
//   - Replay: an attacker re-scanning an old QR gets a signature-valid but
//     expired payload → rejected. An unexpired payload re-scan is also
//     rejected because the scanner is already permanently linked.
//   - Forgery: without the server secret the HMAC cannot be reproduced.
//   - Cross-account theft: the payload is bound to a specific user id; the
//     code owner lookup must agree with the payload user id.

import crypto from 'crypto';
import { env } from '../config/env';

const PAYLOAD_VERSION = 'v1';

export function hmacFor(payloadBody: string): string {
  return crypto.createHmac('sha256', env.REFERRAL_QR_SECRET).update(payloadBody).digest('hex');
}

/** Builds a signed referral QR payload for a user + code. */
export function signReferralPayload(userId: string, code: string, expiresAt: Date): string {
  const body = `${PAYLOAD_VERSION}.${userId}.${code}.${Math.floor(expiresAt.getTime() / 1000)}`;
  return `${body}.${hmacFor(body)}`;
}

export interface VerifiedPayload {
  userId: string;
  code: string;
  expiresAt: Date;
}

export type VerifyResult =
  | { ok: true; payload: VerifiedPayload }
  | { ok: false; reason: string };

/** Constant-time signature verification + expiry check. */
export function verifyReferralPayload(payload: string): VerifyResult {
  if (typeof payload !== 'string' || payload.length > 1024) {
    return { ok: false, reason: 'Malformed referral payload' };
  }
  const parts = payload.split('.');
  if (parts.length !== 5 || parts[0] !== PAYLOAD_VERSION) {
    return { ok: false, reason: 'Unsupported referral payload version' };
  }
  const [, userId, code, expRaw, sig] = parts;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= 0) {
    return { ok: false, reason: 'Malformed referral expiry' };
  }
  const body = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}`;
  const expected = hmacFor(body);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'Invalid referral signature' };
  }
  if (exp * 1000 < Date.now()) {
    return { ok: false, reason: 'This referral code has expired' };
  }
  return { ok: true, payload: { userId, code, expiresAt: new Date(exp * 1000) } };
}

/** Generates a collision-resistant referral code (31^10 ≈ 8.1e14 space). */
export function generateReferralCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  const bytes = crypto.randomBytes(10);
  let code = '';
  for (let i = 0; i < 10; i++) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
}
