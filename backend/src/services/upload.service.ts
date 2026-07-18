import { Request, Response } from 'express';
import { env } from '../config/env';
import { StorageService } from './storage.service';

export class UploadService {
  static async upload(req: Request, res: Response) {
    try {
      const { image, mimetype, filename } = req.body;

      if (!image || !mimetype) {
        return res.status(400).json({ error: 'No image data or mimetype provided' });
      }

      const buffer = Buffer.from(image, 'base64');

      // Infer user ID from request auth (optional, for path organisation)
      const userId = (req as any).user?.id || 'anonymous';

      const result = await StorageService.upload(buffer, {
        userId,
        fileType: 'general',
        originalName: filename || 'upload',
        mimetype,
      });

      const fullUrl = `${env.APP_URL}${result.url}`;
      console.log(`📸 [UPLOAD] Uploaded via StorageService: ${result.id} (${buffer.length} bytes) -> ${fullUrl}`);
      res.json({ url: fullUrl });
    } catch (error: any) {
      console.error('❌ Upload error:', error);
      res.status(500).json({ error: error.message });
    }
  }
}
