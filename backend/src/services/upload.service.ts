import { Request, Response } from 'express';
import { StorageService } from './storage.service';
import {
  classifyFileVisibility,
  sanitizeUploadFileType,
  validateUploadMime,
} from '../security/file-policy';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

export class UploadService {
  static async upload(req: Request, res: Response) {
    let buffer: Buffer | null = null;
    try {
      // Authentication is enforced by authMiddleware on the route. Defence in
      // depth: never fall back to an `anonymous` owner.
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized: sign in to upload files.' });
      }

      const { image, mimetype, filename, file_type } = req.body;

      if (!image || !mimetype) {
        return res.status(400).json({ error: 'No image data or mimetype provided' });
      }

      const normalizedMime = validateUploadMime(mimetype);
      if (!normalizedMime) {
        return res.status(415).json({
          error: 'Unsupported file type. Only JPEG, PNG, WebP and HEIC images are accepted.',
        });
      }

      buffer = Buffer.from(image, 'base64');

      if (buffer.length === 0) {
        return res.status(400).json({ error: 'Empty upload.' });
      }
      if (buffer.length > MAX_UPLOAD_BYTES) {
        return res.status(413).json({ error: `File too large. Max ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.` });
      }

      // Client-declared category, sanitised. Unknown categories degrade to
      // `general`, which is PRIVATE — secure by default. Only `profile`
      // (and legacy `avatar`) uploads become publicly readable.
      const fileType = sanitizeUploadFileType(file_type);
      const visibility = classifyFileVisibility(fileType);

      const result = await StorageService.upload(buffer, {
        userId,
        fileType,
        originalName: filename || 'upload',
        mimetype: normalizedMime,
        visibility,
      });

      // Never log the base64 payload; file id + size are enough for support.
      console.log(`📸 [UPLOAD] user=${userId} file=${result.id} (${buffer.length} bytes, ${visibility})`);
      res.json({ url: result.url, file_id: result.id, visibility });
    } catch (error: any) {
      console.error('❌ Upload error:', error.message);
      res.status(500).json({ error: 'Upload failed. Please try again.' });
    } finally {
      buffer = null;
    }
  }
}
