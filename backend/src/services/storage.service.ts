import { pool } from '../config/database';
import {
  PUBLIC_BUCKET,
  PRIVATE_BUCKET,
  uploadToSupabase,
  publicStorageUrl,
  createSignedStorageUrl,
  deleteStorageObject,
  hasSupabaseStorage,
} from '../config/supabase';
import { classifyFileVisibility, FileVisibility, StoredFileRecord } from '../security/file-policy';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const UPLOADS_DIR = path.resolve(__dirname, '../../uploads');

/**
 * Resolve a stored `local/...` path inside UPLOADS_DIR and refuse traversal.
 * Legacy rows (migration 029) embedded a path extracted from a user-supplied
 * URL, so containment must be enforced at read/delete time as well.
 */
function resolveLocalPath(storedPath: string): string | null {
  const relative = String(storedPath ?? '').replace(/^local\//, '');
  const resolved = path.resolve(UPLOADS_DIR, relative);
  const prefix = UPLOADS_DIR + path.sep;
  if (resolved !== UPLOADS_DIR && !resolved.startsWith(prefix)) return null;
  return resolved;
}

interface StoredFile extends StoredFileRecord {
  bucket: 'supabase' | 'local';
  storage_bucket: string;
  path: string;
  original_name: string | null;
  mimetype: string;
  size_bytes: number | null;
  created_at: string;
}

export class StorageService {
  /**
   * Upload a file and return a permanent file ID.
   * Files are organised under users/{userId}/{type}/{uuid}.{ext}.
   *
   * Visibility decides the storage location:
   *   * public  → the public `uploads` bucket (profile photos only)
   *   * private → the private `secure-documents` bucket (everything else)
   * Private files are NEVER given a public URL.
   */
  static async upload(
    buffer: Buffer,
    options: {
      userId: string;
      fileType: string;  // e.g. 'profile', 'license', 'registration', 'inspection', 'id_photo'
      originalName: string;
      mimetype: string;
      visibility?: FileVisibility;
    }
  ): Promise<{ id: string; url: string }> {
    const ext = (options.mimetype.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
    // Defensive path-segment sanitisation: userId and fileType are never
    // trusted raw (path traversal via `..` or `/`).
    const safeUserId = String(options.userId).replace(/[^a-zA-Z0-9-]/g, '');
    const safeFileType = String(options.fileType).replace(/[^a-z0-9_]/gi, '') || 'general';
    const visibility: FileVisibility =
      options.visibility ?? classifyFileVisibility(safeFileType);
    const bucket = visibility === 'public' ? PUBLIC_BUCKET : PRIVATE_BUCKET;

    const storagePath = `users/${safeUserId}/${safeFileType}/${uuidv4()}.${ext}`;

    // Always try Supabase first (persistent storage)
    const supabasePath = await uploadToSupabase(buffer, storagePath, options.mimetype, bucket);
    if (supabasePath) {
      // Store permanent reference
      const result = await pool.query(
        `INSERT INTO storage_files (user_id, bucket, storage_bucket, path, original_name, mimetype, size_bytes, visibility)
         VALUES ($1, 'supabase', $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [options.userId, bucket, storagePath, options.originalName, options.mimetype, buffer.length, visibility]
      );
      const fileId = result.rows[0].id;
      return { id: fileId, url: `/api/files/${fileId}` };
    }

    // Fallback to local filesystem. Local files are served exclusively through
    // the authorized /api/files/:id route — never a static mount.
    const uploadDir = path.join(UPLOADS_DIR, safeUserId, safeFileType);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const localPath = path.join(uploadDir, `${uuidv4()}.${ext}`);
    const relativePath = `local/${safeUserId}/${safeFileType}/${path.basename(localPath)}`;

    // Stream write instead of blocking sync write
    const readStream = Readable.from(buffer);
    const writeStream = fs.createWriteStream(localPath);
    await pipeline(readStream, writeStream);

    const result = await pool.query(
      `INSERT INTO storage_files (user_id, bucket, storage_bucket, path, original_name, mimetype, size_bytes, visibility)
       VALUES ($1, 'local', $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [options.userId, 'local', relativePath, options.originalName, options.mimetype, buffer.length, visibility]
    );
    const fileId = result.rows[0].id;
    return { id: fileId, url: `/api/files/${fileId}` };
  }

  /** Load the authoritative file record (visibility included). */
  static async getFileRecord(fileId: string): Promise<StoredFile | null> {
    const result = await pool.query(
      `SELECT id, user_id, bucket, storage_bucket, path, original_name, mimetype, size_bytes, visibility, created_at
         FROM storage_files WHERE id = $1`,
      [fileId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Resolve a fetchable upstream URL / local path for an ALREADY-AUTHORIZED
   * file record.
   *
   * Public files  → the public storage URL.
   * Private files → a short-lived signed URL. If a legacy record still lives
   *                 in the public bucket it is signed as well (the public
   *                 copy must be migrated; see
   *                 scripts/migrate-storage-visibility.cjs).
   */
  static async getAccessUrl(
    fileId: string,
    knownFile?: StoredFile | null,
  ): Promise<{ url: string | null; mimetype: string | null; file: StoredFile | null }> {
    const file = knownFile ?? (await this.getFileRecord(fileId));
    if (!file) return { url: null, mimetype: null, file: null };

    if (file.bucket === 'supabase') {
      // Every Supabase object is delivered through a short-lived signed URL.
      // The `uploads` bucket is private (migration
      // 20261028_private_uploads_bucket); public *visibility* means "anyone may
      // ask /api/files/:id", not "the underlying object has a public URL".
      const bucket =
        file.storage_bucket ||
        (file.visibility === 'public' ? PUBLIC_BUCKET : PRIVATE_BUCKET);
      const signed = await createSignedStorageUrl(file.path, 300, bucket);
      if (signed) return { url: signed, mimetype: file.mimetype, file };
      if (file.visibility === 'public') {
        // Legacy fallback only for a deployment that has not applied the
        // private-bucket migration yet.
        return {
          url: publicStorageUrl(file.path, bucket),
          mimetype: file.mimetype,
          file,
        };
      }
      if (file.storage_bucket === PUBLIC_BUCKET) {
        // Last-resort fallback for un-migrated legacy objects; still requires
        // the signed URL path and MUST be migrated to the private bucket.
        console.warn(
          `[STORAGE] ⚠️ Private file ${fileId} still stored in public bucket "${PUBLIC_BUCKET}" and could not be signed. Run scripts/migrate-storage-visibility.cjs.`,
        );
      }
      return { url: null, mimetype: file.mimetype, file };
    }

    // Local bucket
    const localPath = resolveLocalPath(file.path);
    if (!localPath || !fs.existsSync(localPath)) {
      return { url: null, mimetype: file.mimetype, file };
    }

    return { url: localPath, mimetype: file.mimetype, file };
  }

  /**
   * Stream a local file to the HTTP response.
   */
  static streamLocalFile(filePath: string, res: any): void {
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  }

  /**
   * Delete a file reference (and the underlying object/file if possible).
   */
  static async delete(fileId: string): Promise<boolean> {
    const result = await pool.query(
      `DELETE FROM storage_files WHERE id = $1 RETURNING bucket, storage_bucket, path, visibility`,
      [fileId]
    );
    if (result.rows.length === 0) return false;

    const { bucket, storage_bucket, path: filePath } = result.rows[0];

    if (bucket === 'supabase' && hasSupabaseStorage()) {
      const targetBucket = storage_bucket || (result.rows[0].visibility === 'public' ? PUBLIC_BUCKET : PRIVATE_BUCKET);
      await deleteStorageObject(filePath, targetBucket);
      // Legacy private object may still exist in the public bucket — remove it
      // too so no stale public copy remains.
      if (targetBucket !== PUBLIC_BUCKET && result.rows[0].visibility !== 'public') {
        await deleteStorageObject(filePath, PUBLIC_BUCKET).catch(() => false);
      }
    } else if (bucket === 'local') {
      const localPath = resolveLocalPath(filePath);
      try {
        if (localPath && fs.existsSync(localPath)) await fs.promises.unlink(localPath);
      } catch { /* ignore */ }
    }

    return true;
  }
}
