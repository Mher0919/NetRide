// backend/src/security/file-policy.ts
//
// Pure, dependency-free authorization policy for stored files. Kept free of
// DB/HTTP imports so the full permission matrix can be unit-tested offline
// (see src/security/__tests__/security.unit.test.ts).
//
// Core rule (deny by default):
//   * A file explicitly classified `public` (intentionally public profile
//     photos) is readable by anyone.
//   * Every other file is readable only by its owner or by an administrator
//     whose role was resolved server-side from the database.
//   * Being authenticated is NOT sufficient. A valid file id is NEVER
//     sufficient.

export type FileVisibility = 'public' | 'private';

export interface StoredFileRecord {
  id: string;
  user_id: string | null;
  visibility: string | null;
  bucket?: string | null;
  storage_bucket?: string | null;
  path?: string | null;
  mimetype?: string | null;
}

export interface FileRequester {
  id?: string | null;
  role?: string | null;
}

/**
 * File-type -> visibility classification. Only intentionally public profile
 * imagery is public. Every verification artifact (IDs, licenses, insurance,
 * registration, inspection, face enrollment, vehicle photos) is private.
 */
const PUBLIC_FILE_TYPES = new Set(['profile', 'avatar']);

export function classifyFileVisibility(fileType: string | null | undefined): FileVisibility {
  const normalized = (fileType ?? '').toString().trim().toLowerCase();
  return PUBLIC_FILE_TYPES.has(normalized) ? 'public' : 'private';
}

/**
 * Normalize a client-supplied file type into a safe storage path segment.
 * Anything outside [a-z0-9_-] that is not an allowlisted type degrades to
 * `general` (private).
 */
export function sanitizeUploadFileType(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (/^[a-z][a-z0-9_]{0,31}$/.test(value)) return value;
  return 'general';
}

const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export function validateUploadMime(mimetype: unknown): string | null {
  if (typeof mimetype !== 'string') return null;
  const normalized = mimetype.trim().toLowerCase();
  return ALLOWED_IMAGE_MIMES.has(normalized) ? normalized : null;
}

/**
 * Resource-level authorization for a single file. This is the single
 * decision point used by `GET /api/files/:id`.
 */
export function canAccessFile(file: StoredFileRecord, requester: FileRequester | null | undefined): boolean {
  if (file.visibility === 'public') return true;
  const userId = requester?.id ?? null;
  if (!userId) return false;
  if ((requester?.role ?? '').toUpperCase() === 'ADMIN') return true;
  return file.user_id != null && file.user_id === userId;
}

/** Admins and the file's owner may manage (delete) a private file. */
export function canManageFile(file: StoredFileRecord, requester: FileRequester | null | undefined): boolean {
  const userId = requester?.id ?? null;
  if (!userId) return false;
  if ((requester?.role ?? '').toUpperCase() === 'ADMIN') return true;
  return file.user_id != null && file.user_id === userId;
}

/** Safe response headers per visibility class. */
export function cacheControlForVisibility(visibility: string | null | undefined): string {
  return visibility === 'public'
    ? 'public, max-age=31536000, immutable'
    : 'private, no-store';
}
