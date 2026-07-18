import { Router, Request, Response } from 'express';
import https from 'https';
import http from 'http';
import { StorageService } from '../services/storage.service';

const router = Router();

/**
 * GET /api/files/:id
 * Returns a file by its storage_files.id.
 * For Supabase files: proxies the content through (avoids redirect issues
 *   with Flutter's CachedNetworkImage which may not follow redirects well).
 * For local files: streams the file directly.
 *
 * No auth middleware — file IDs are random UUIDs (unguessable).
 * Images embedded in <img> tags (e.g. admin dashboard) cannot carry
 * auth headers, so requiring authentication would break all image loads.
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { url, mimetype } = await StorageService.getAccessUrl(req.params.id);
    if (!url) {
      return res.status(404).json({ error: 'File not found' });
    }

    // If it's a local path, stream it
    if (!url.startsWith('http')) {
      res.setHeader('Content-Type', mimetype || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return StorageService.streamLocalFile(url, res);
    }

    // For Supabase/public URLs, proxy the content through instead of
    // redirecting. Redirects (302) can fail silently in some HTTP clients
    // (Flutter's CachedNetworkImage), but proxying always works.
    const proxyGet = url.startsWith('https') ? https.get : http.get;
    proxyGet(url, (proxyRes) => {
      // Forward status code and content-type from upstream
      // (or fall back to the stored mimetype).
      const ct = proxyRes.headers['content-type'] || mimetype || 'application/octet-stream';
      res.statusCode = proxyRes.statusCode ?? 200;
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
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

export default router;
