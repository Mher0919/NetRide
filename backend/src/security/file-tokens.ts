// backend/src/security/file-tokens.ts
//
// Short-lived, purpose-scoped access tokens for private files. Some legitimate
// consumers cannot attach an Authorization header to an <img> request (the
// admin dashboard document-review UI, for example). Those flows receive a
// signed URL of the form:
//
//     /api/files/{fileId}?token=<JWT>
//
// The token only proves WHO is asking; the file route still re-evaluates
// owner/admin authorization against the database on every request, so a token
// can never widen access beyond what the subject is currently entitled to.

import jwt from 'jsonwebtoken';
import { env } from '../config/env';

const TOKEN_PURPOSE = 'file-access';
const TOKEN_TTL = '15m';

export interface FileAccessTokenPayload {
  fid: string;
  uid: string;
  t: typeof TOKEN_PURPOSE;
}

export function signFileAccessToken(fileId: string, userId: string): string {
  const payload: FileAccessTokenPayload = { fid: fileId, uid: userId, t: TOKEN_PURPOSE };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: TOKEN_TTL, algorithm: 'HS256' });
}

export function verifyFileAccessToken(token: string): { fileId: string; userId: string } | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as any;
    if (!decoded || decoded.t !== TOKEN_PURPOSE) return null;
    if (typeof decoded.fid !== 'string' || typeof decoded.uid !== 'string') return null;
    if (!decoded.fid || !decoded.uid) return null;
    return { fileId: decoded.fid, userId: decoded.uid };
  } catch {
    return null;
  }
}
