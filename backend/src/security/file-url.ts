// backend/src/security/file-url.ts
//
// Shared validation for user-supplied file URLs (driver documents, rider ID
// photos, profile images). Accepts a relative /api/files/{id} reference or
// an absolute http(s) URL. Non-web schemes (javascript:, data:, file:, ...)
// are rejected: these values are rendered as <img> sources and opened via
// window.open in the admin dashboard, so any other scheme would be a
// stored-XSS / tab-nabbing vector.

import { z } from 'zod';

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

export const fileUrlSchema = () =>
  z
    .string()
    .trim()
    .max(2048)
    .refine(v => v.startsWith('/api/files/') || isHttpUrl(v), {
      message: 'Must be a valid http(s) URL or /api/files/{id} path',
    });
