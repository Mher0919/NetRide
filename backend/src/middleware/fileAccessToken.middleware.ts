import { Request, Response, NextFunction } from 'express';
import { pool } from '../config/database';
import { signFileAccessToken } from '../security/file-tokens';

const FILE_URL_RE = /\/api\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![?&][A-Za-z0-9_=-]*token=)/gi;

/**
 * Admin JSON responses can embed private file references (driver licenses,
 * ID cards, insurance documents). The admin dashboard renders those URLs in
 * <img> tags, which cannot carry an Authorization header.
 *
 * This middleware rewrites `/api/files/{id}` references for PRIVATE files to
 * include a short-lived, purpose-scoped access token minted for the
 * authenticated administrator. Public profile photos are left untouched
 * (they need no authorization). The file route still re-evaluates
 * owner/admin authorization on every request, so the token cannot widen
 * access.
 *
 * Mounted on /api/admin only.
 */
export function attachPrivateFileAccessTokens(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;
  if (!user?.id) return next();

  const originalJson = res.json.bind(res);
  res.json = function (body: any) {
    if (body === null || body === undefined || typeof body !== 'object') {
      return originalJson(body);
    }

    const ids = new Set<string>();
    collectFileIds(body, ids);
    if (ids.size === 0) {
      return originalJson(body);
    }

    pool
      .query(`SELECT id, visibility FROM storage_files WHERE id = ANY($1::uuid[])`, [Array.from(ids)])
      .then((result) => {
        const privateIds = new Set<string>(
          result.rows.filter((r: any) => r.visibility !== 'public').map((r: any) => r.id),
        );
        if (privateIds.size > 0) {
          applyTokens(body, privateIds, user.id);
        }
        originalJson(body);
      })
      .catch(() => {
        // Fail closed: send the response without tokens rather than break the
        // endpoint. Private images will simply not render.
        originalJson(body);
      });
    return res;
  } as any;

  next();
}

function collectFileIds(obj: any, ids: Set<string>): void {
  if (obj === null || obj === undefined) return;
  if (Array.isArray(obj)) {
    for (const item of obj) collectFileIds(item, ids);
    return;
  }
  if (typeof obj === 'string') {
    FILE_URL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FILE_URL_RE.exec(obj)) !== null) {
      ids.add(match[1]);
    }
    return;
  }
  if (typeof obj === 'object') {
    for (const key of Object.keys(obj)) collectFileIds(obj[key], ids);
  }
}

function applyTokens(obj: any, privateIds: Set<string>, adminUserId: string): void {
  if (obj === null || obj === undefined) return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === 'string') obj[i] = rewriteUrl(obj[i], privateIds, adminUserId);
      else applyTokens(obj[i], privateIds, adminUserId);
    }
    return;
  }
  if (typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (typeof value === 'string') {
        obj[key] = rewriteUrl(value, privateIds, adminUserId);
      } else if (value !== null && typeof value === 'object') {
        applyTokens(value, privateIds, adminUserId);
      }
    }
  }
}

function rewriteUrl(value: string, privateIds: Set<string>, adminUserId: string): string {
  if (!value.includes('/api/files/')) return value;
  FILE_URL_RE.lastIndex = 0;
  return value.replace(
    // Only bare `/api/files/{id}` references are rewritten; URLs that already
    // carry a query string (e.g. an existing token) are left untouched.
    /(\/api\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))(?!\?)/gi,
    (match, _full: string, id: string) => {
      if (!privateIds.has(id)) return match;
      const token = signFileAccessToken(id, adminUserId);
      return `${match}?token=${encodeURIComponent(token)}`;
    },
  );
}
