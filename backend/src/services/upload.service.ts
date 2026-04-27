// backend/src/services/upload.service.ts
import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env';

export class UploadService {
  /**
   * Processes a base64 string, saves it to the filesystem, and returns a URL.
   */
  static async upload(req: Request, res: Response) {
    try {
      const { image, mimetype, filename } = req.body;

      if (!image || !mimetype) {
        return res.status(400).json({ error: 'No image data or mimetype provided' });
      }

      // 1. Generate unique filename
      const extension = mimetype.split('/')[1] || 'jpg';
      const safeFilename = `${uuidv4()}.${extension}`;
      const uploadDir = path.join(__dirname, '../../uploads');
      const filePath = path.join(uploadDir, safeFilename);

      // 2. Ensure directory exists
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      // 3. Save buffer to file
      const buffer = Buffer.from(image, 'base64');
      fs.writeFileSync(filePath, buffer);

      // 4. Construct URL
      // We use APP_URL from env, e.g., http://localhost:3000
      const fileUrl = `${env.APP_URL}/uploads/${safeFilename}`;

      console.log(`📸 [UPLOAD] File saved: ${safeFilename} (${buffer.length} bytes) -> ${fileUrl}`);
      
      res.json({ url: fileUrl });
    } catch (error: any) {
      console.error('❌ Upload error:', error);
      res.status(500).json({ error: error.message });
    }
  }
}
