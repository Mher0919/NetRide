import { env } from './env';

const BUCKET_NAME = 'uploads';

/**
 * Server-side key for Supabase Storage. The anon key is a short-lived JWT
 * meant for browsers; using it server-side causes "Invalid Compact JWS"
 * (403) when the JWT expires. The service-role key never expires and
 * bypasses RLS — it must ONLY be used server-side.
 */
function getSupabaseAuthKey(): string | null {
  // Prefer service-role key (never expires, full admin access)
  if (env.SUPABASE_SERVICE_ROLE_KEY) return env.SUPABASE_SERVICE_ROLE_KEY;
  // Fallback to anon key (may expire — log a warning)
  if (env.SUPABASE_ANON_KEY) {
    console.warn(
      '[SUPABASE] ⚠️  Using SUPABASE_ANON_KEY for storage uploads. ' +
      'This JWT expires and causes "Invalid Compact JWS" (403). ' +
      'Set SUPABASE_SERVICE_ROLE_KEY in your environment.'
    );
    return env.SUPABASE_ANON_KEY;
  }
  return null;
}

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
  const authKey = getSupabaseAuthKey();
  if (!env.SUPABASE_URL || !authKey) return null;

  const storageUrl = `${env.SUPABASE_URL}/storage/v1/object/${BUCKET_NAME}/${filename}`;

  try {
    const res = await fetch(storageUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authKey}`,
        'Content-Type': mimetype,
        'x-upsert': 'true',
      },
      body: new Uint8Array(buffer),
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
