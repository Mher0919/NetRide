import crypto from 'crypto';
import { env } from '../../config/env';

/** Normalize a phone number to E.164. US (+1) is the only live market today. */
export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** 256 bits of cryptographic randomness, URL-safe. */
export function generateInviteToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function buildGroupInviteLink(token: string): string {
  return `${env.APP_URL.replace(/\/+$/, '')}/join/group/${encodeURIComponent(token)}`;
}

export function buildGroupInviteSms(args: {
  inviterName: string;
  groupName: string;
  token: string;
}): string {
  const link = buildGroupInviteLink(args.token);
  const stores = [env.IOS_APP_STORE_URL, env.ANDROID_PLAY_STORE_URL]
    .filter((url): url is string => !!url && url.trim().length > 0)
    .map((url) => url.trim());
  const storeLine = stores.length > 0 ? `\n\nGet NetRide: ${stores.join(' · ')}` : '';
  return (
    `Hey! ${args.inviterName} invited you to "${args.groupName}" on NetRide. ` +
    `We're organizing a group ride so we can coordinate pickups and split the fare. ` +
    `Join here: ${link}${storeLine}`
  );
}

/**
 * Native app deep link used by the landing page / in-app notification.
 * The custom scheme works when the app is installed; the https link is the
 * universal-link/install fallback.
 */
export function buildGroupInviteDeepLink(token: string): string {
  return `netride://group/join?token=${encodeURIComponent(token)}`;
}
