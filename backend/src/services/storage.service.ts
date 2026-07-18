import { pool } from '../config/database';
import { env } from '../config/env';
import { uploadToSupabase } from '../config/supabase';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

const UPLOADS_DIR = path.join(__dirname, '../../uploads');

interface StoredFile {
  id: string;
  user_id: string | null;
  bucket: 'supabase' | 'local';
  path: string;
  original_name: string | null;
  mimetype: string;
  size_bytes: number | null;
  created_at: string;
}

export class StorageService {
  /**
   * Upload a file and return a permanent file ID.
   * Files are organised under users/{userId}/{type}/{uuid}.{ext} on Supabase.
   */
  static async upload(
    buffer: Buffer,
    options: {
      userId: string;
      fileType: string;  // e.g. 'profile', 'license', 'registration', 'inspection', 'id_photo'
      originalName: string;
      mimetype: string;
    }
  ): Promise<{ id: string; url: string }> {
    const ext = options.mimetype.split('/')[1] || 'jpg';
    const storagePath = `users/${options.userId}/${options.fileType}/${uuidv4()}.${ext}`;

    // Always try Supabase first (persistent storage)
    const supabaseUrl = await uploadToSupabase(buffer, storagePath, options.mimetype);
    if (supabaseUrl) {
      // Store permanent reference
      const result = await pool.query(
        `INSERT INTO storage_files (user_id, bucket, path, original_name, mimetype, size_bytes)
         VALUES ($1, 'supabase', $2, $3, $4, $5)
         RETURNING id`,
        [options.userId, storagePath, options.originalName, options.mimetype, buffer.length]
      );
      const fileId = result.rows[0].id;
      return { id: fileId, url: `/api/files/${fileId}` };
    }

    // Fallback to local filesystem
    const uploadDir = path.join(UPLOADS_DIR, options.userId, options.fileType);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const localPath = path.join(uploadDir, `${uuidv4()}.${ext}`);
    const relativePath = `local/${options.userId}/${options.fileType}/${path.basename(localPath)}`;
    fs.writeFileSync(localPath, buffer);

    const result = await pool.query(
      `INSERT INTO storage_files (user_id, bucket, path, original_name, mimetype, size_bytes)
       VALUES ($1, 'local', $2, $3, $4, $5)
       RETURNING id`,
      [options.userId, relativePath, options.originalName, options.mimetype, buffer.length]
    );
    const fileId = result.rows[0].id;
    return { id: fileId, url: `/api/files/${fileId}` };
  }

  /**
   * Get an access URL for a stored file.
   * For Supabase: generates a signed public URL (valid as long as bucket is public).
   * For local: returns the local file path.
   */
  static async getAccessUrl(fileId: string): Promise<{ url: string | null; mimetype: string | null }> {
    const result = await pool.query(
      `SELECT bucket, path, mimetype FROM storage_files WHERE id = $1`,
      [fileId]
    );
    if (result.rows.length === 0) return { url: null, mimetype: null };

    const { bucket, path: filePath, mimetype } = result.rows[0];

    if (bucket === 'supabase') {
      const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/uploads/${filePath}`;
      return { url: publicUrl, mimetype };
    }

    // Local bucket
    const localPath = path.join(UPLOADS_DIR, filePath.replace('local/', ''));
    if (!fs.existsSync(localPath)) return { url: null, mimetype: null };

    return { url: localPath, mimetype };
  }

  /**
   * Stream a local file to the HTTP response.
   */
  static streamLocalFile(filePath: string, res: any): void {
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  }

  /**
   * Delete a file reference (and the underlying file if possible).
   */
  static async delete(fileId: string): Promise<boolean> {
    const result = await pool.query(
      `DELETE FROM storage_files WHERE id = $1 RETURNING bucket, path`,
      [fileId]
    );
    if (result.rows.length === 0) return false;

    const { bucket, path: filePath } = result.rows[0];

    if (bucket === 'local') {
      const localPath = path.join(UPLOADS_DIR, filePath.replace('local/', ''));
      try {
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
      } catch { /* ignore */ }
    }

    return true;
  }
}
