import { Router, Request, Response } from 'express';
import https from 'https';
import http from 'http';
import fs from 'fs';
import { StorageService } from '../services/storage.service';
import { canAccessFile, cacheControlForVisibility } from '../security/file-policy';
import { signFileAccessToken, verifyFileAccessToken } from '../security/file-tokens';
import { pool } from '../config/database';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/files/:id
 *
 * Serves a stored file with resource-level authorization:
 *
 *  * Public files (intentionally public profile photographs) are readable by
 *    anyone — the product behaviour this endpoint was built around.
 *  * Private files (government IDs, licenses, insurance/registration/
 *    inspection documents, face enrollment) require the requester to be the
 *    file's owner or an administrator. Authentication alone is NOT enough and
 *    knowing the UUID is NEVER enough.
 *
 * Authorized private-file callers may authenticate with:
 *  (a) `Authorization: Bearer <jwt>` — owner/admin; or
 *  (b) `?token=<short-lived file-access JWT>` — issued only to the owner/admin
 *      for contexts that cannot set headers (admin dashboard <img> tags).
 *      The token identifies the subject; owner/admin authorization is still
 *      re-evaluated against the database on every request.
 */
router.get('/:id', async (req: Request, res: Response) => {
  const fileId = req.params.id;
  if (!UUID_RE.test(fileId)) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    const file = await StorageService.getFileRecord(fileId);
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    // ---- Resource-level authorization ------------------------------------
    let requester = (req as any).user
      ? { id: (req as any).user.id, role: (req as any).user.role }
      : null;

    if (!requester && typeof req.query.token === 'string') {
      const token = verifyFileAccessToken(req.query.token);
      if (token && token.fileId === fileId) {
        const userRes = await pool.query(
          'SELECT id, role, is_active FROM users WHERE id = $1',
          [token.userId],
        );
        const dbUser = userRes.rows[0];
        if (dbUser && dbUser.is_active !== false) {
          requester = { id: dbUser.id, role: dbUser.role };
        }
      }
    }

    // Bearer tokens are only signature-verified by the global identifyUser
    // middleware. Re-read the role/active state here so a demoted or
    // deactivated administrator cannot keep reading private files until JWT
    // expiry (the same rule the query-token path already enforces).
    if (requester) {
      const userRes = await pool.query(
        'SELECT id, role, is_active FROM users WHERE id = $1',
        [requester.id],
      );
      const dbUser = userRes.rows[0];
      requester = dbUser && dbUser.is_active !== false
        ? { id: dbUser.id, role: dbUser.role }
        : null;
    }

    if (!canAccessFile(file, requester)) {
      // 404 (not 403) for private files: do not disclose that an object with
      // this id exists to unauthorized callers.
      return res.status(404).json({ error: 'File not found' });
    }

    // Authorize BEFORE minting a signed storage URL. Knowing a file UUID must
    // never trigger a service-role signing request.
    const { url, mimetype } = await StorageService.getAccessUrl(fileId, file);

    if (!url) {
      return res.status(404).json({ error: 'File not found' });
    }

    const isPrivate = file.visibility !== 'public';
    const cacheControl = cacheControlForVisibility(file.visibility);
    // Never let a stored object be sniffed into an active content type
    // (e.g. an uploaded SVG/HTML rendered as a document).
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const contentType = mimetype || 'application/octet-stream';
    if (!contentType.startsWith('image/')) {
      res.setHeader('Content-Disposition', 'attachment');
    }

    // If it's a local path, stream it
    if (!url.startsWith('http')) {
      const stat = await fs.promises.stat(url).catch(() => null);
      if (!stat) return res.status(404).json({ error: 'File not found' });
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Cache-Control', cacheControl);
      if (isPrivate) res.setHeader('Pragma', 'no-cache');
      return StorageService.streamLocalFile(url, res);
    }

    // For Supabase URLs, proxy the content through instead of redirecting.
    // Redirects (302) can fail silently in some HTTP clients (Flutter's
    // CachedNetworkImage), and proxying keeps the signed URL server-side.
    const proxyGet = url.startsWith('https') ? https.get : http.get;
    proxyGet(url, (proxyRes) => {
      if ((proxyRes.statusCode ?? 500) >= 400) {
        proxyRes.resume();
        return res.status(404).json({ error: 'File not found' });
      }
      const ct = proxyRes.headers['content-type'] || contentType;
      res.statusCode = proxyRes.statusCode ?? 200;
      res.setHeader('Content-Type', ct);
      if (proxyRes.headers['content-length']) {
        res.setHeader('Content-Length', proxyRes.headers['content-length']);
      }
      res.setHeader('Cache-Control', cacheControl);
      if (isPrivate) res.setHeader('Pragma', 'no-cache');
      proxyRes.pipe(res);
    }).on('error', (err) => {
      console.error('[FILES] Proxy error:', err.message);
      res.status(502).json({ error: 'Failed to fetch file from upstream' });
    });
  } catch (err: any) {
    console.error('[FILES] Error serving file:', err.message);
    res.status(500).json({ error: 'Failed to serve file' });
  }
});

/**
 * GET /api/files/:id/access-url
 *
 * Returns a short-lived, purpose-scoped URL for a private file. Only the
 * file's owner or an administrator may mint one. Used by clients that cannot
 * attach Authorization headers to image requests.
 */
router.get('/:id/access-url', async (req: Request, res: Response) => {
  const fileId = req.params.id;
  if (!UUID_RE.test(fileId)) {
    return res.status(404).json({ error: 'File not found' });
  }
  const requester = (req as any).user;
  if (!requester?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const file = await StorageService.getFileRecord(fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });

    if (!canAccessFile(file, { id: requester.id, role: requester.role })) {
      return res.status(404).json({ error: 'File not found' });
    }

    if (file.visibility === 'public') {
      return res.json({ url: `/api/files/${fileId}` });
    }

    const token = signFileAccessToken(fileId, requester.id);
    res.json({ url: `/api/files/${fileId}?token=${encodeURIComponent(token)}`, expiresInSeconds: 900 });
  } catch (err: any) {
    console.error('[FILES] access-url error:', err.message);
    res.status(500).json({ error: 'Failed to build file URL' });
  }
});

export default router;
