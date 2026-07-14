import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env';
import { uploadToSupabase } from '../config/supabase';

export class UploadService {
  static async upload(req: Request, res: Response) {
    try {
      const { image, mimetype, filename } = req.body;

      if (!image || !mimetype) {
        return res.status(400).json({ error: 'No image data or mimetype provided' });
      }

      const extension = mimetype.split('/')[1] || 'jpg';
      const safeFilename = `${uuidv4()}.${extension}`;
      const buffer = Buffer.from(image, 'base64');

      // Try Supabase Storage first (persistent across deploys/instances)
      const supabaseUrl = await uploadToSupabase(buffer, safeFilename, mimetype);
      if (supabaseUrl) {
        console.log(`📸 [UPLOAD] Uploaded to Supabase: ${safeFilename} (${buffer.length} bytes) -> ${supabaseUrl}`);
        return res.json({ url: supabaseUrl });
      }

      // Fall back to local filesystem
      const uploadDir = path.join(__dirname, '../../uploads');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      const filePath = path.join(uploadDir, safeFilename);
      fs.writeFileSync(filePath, buffer);

      const fileUrl = `${env.APP_URL}/uploads/${safeFilename}`;
      console.log(`📸 [UPLOAD] Saved locally: ${safeFilename} (${buffer.length} bytes) -> ${fileUrl}`);

      res.json({ url: fileUrl });
    } catch (error: any) {
      console.error('❌ Upload error:', error);
      res.status(500).json({ error: error.message });
    }
  }
}
