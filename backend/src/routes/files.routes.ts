import { Router, Request, Response } from 'express';
import { StorageService } from '../services/storage.service';

const router = Router();

/**
 * GET /api/files/:id
 * Returns a file by its storage_files.id.
 * For Supabase files: redirects to the public Supabase URL.
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

    // For Supabase URLs, redirect to the public URL
    return res.redirect(302, url);
  } catch (err: any) {
    console.error('[FILES] Error serving file:', err.message);
    res.status(500).json({ error: 'Failed to serve file' });
  }
});

export default router;
