import { env } from './env';

const BUCKET_NAME = 'uploads';

/**
 * Uploads a file to Supabase Storage using the REST API directly.
 * Avoids @supabase/supabase-js WebSocket dependency (fails on Node.js <22).
 * Falls back to null if Supabase is not configured.
 */
export async function uploadToSupabase(
  buffer: Buffer,
  filename: string,
  mimetype: string
): Promise<string | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;

  const storageUrl = `${env.SUPABASE_URL}/storage/v1/object/${BUCKET_NAME}/${filename}`;

  try {
    const res = await fetch(storageUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
        'Content-Type': mimetype,
        'x-upsert': 'true',
      },
      body: new Blob([new Uint8Array(buffer)], { type: mimetype }),
    });

    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      console.error(`[SUPABASE] Upload failed: ${res.status} ${res.statusText} — ${body}`);
      return null;
    }

    const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/${BUCKET_NAME}/${filename}`;
    return publicUrl;
  } catch (err) {
    console.error('[SUPABASE] Upload error:', (err as Error).message);
    return null;
  }
}
