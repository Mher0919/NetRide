import { env } from './env';

/**
 * Storage layout (file-security architecture — see migration 057):
 *   * `uploads`           — public bucket. ONLY intentionally public profile
 *                           photographs. Never verification documents.
 *   * `secure-documents`  — private bucket for government IDs, driver
 *                           licenses, insurance/registration/inspection
 *                           documents and face-enrollment images. Objects are
 *                           reachable only through short-lived signed URLs
 *                           issued after backend authorization.
 */
export const PUBLIC_BUCKET = 'uploads';
export const PRIVATE_BUCKET = 'secure-documents';

let privateBucketVerified = false;

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

export function hasSupabaseStorage(): boolean {
  return !!(env.SUPABASE_URL && getSupabaseAuthKey());
}

function storageBaseUrl(): string {
  return `${env.SUPABASE_URL!.replace(/\/$/, '')}/storage/v1`;
}

/**
 * Creates the private `secure-documents` bucket if it does not exist yet.
 * `public: false` is enforced here so no deployment step can accidentally
 * expose verification documents. Idempotent and cached per process.
 */
export async function ensurePrivateBucket(): Promise<boolean> {
  const authKey = getSupabaseAuthKey();
  if (!env.SUPABASE_URL || !authKey) return false;
  if (privateBucketVerified) return true;

  try {
    const res = await fetch(`${storageBaseUrl()}/bucket/${PRIVATE_BUCKET}`, {
      headers: { 'Authorization': `Bearer ${authKey}`, 'apikey': authKey },
    });
    if (res.status === 200) {
      privateBucketVerified = true;
      return true;
    }
    // 400/404 → create it explicitly, private.
    const create = await fetch(`${storageBaseUrl()}/bucket`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authKey}`,
        'apikey': authKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: PRIVATE_BUCKET, name: PRIVATE_BUCKET, public: false }),
    });
    if (create.ok || create.status === 409) {
      privateBucketVerified = true;
      return true;
    }
    console.error(`[SUPABASE] Failed to create private bucket: ${create.status} ${create.statusText}`);
    return false;
  } catch (err) {
    console.error('[SUPABASE] ensurePrivateBucket error:', (err as Error).message);
    return false;
  }
}

/**
 * Uploads a file to the given Supabase Storage bucket using the REST API.
 * Returns the object key on success, null when storage is unconfigured or
 * the upload failed. Never overwrites an existing object
 * (`x-upsert: false`): storage keys embed a fresh UUID.
 */
export async function uploadToSupabase(
  buffer: Buffer,
  filename: string,
  mimetype: string,
  bucket: string = PUBLIC_BUCKET,
): Promise<string | null> {
  const authKey = getSupabaseAuthKey();
  if (!env.SUPABASE_URL || !authKey) return null;

  if (bucket === PRIVATE_BUCKET) {
    const ready = await ensurePrivateBucket();
    if (!ready) return null;
  }

  const storageUrl = `${storageBaseUrl()}/object/${bucket}/${filename}`;

  try {
    const res = await fetch(storageUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authKey}`,
        'apikey': authKey,
        'Content-Type': mimetype,
        'x-upsert': 'false',
      },
      body: new Uint8Array(buffer),
    });

    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      console.error(`[SUPABASE] Upload failed: ${res.status} ${res.statusText} — ${body}`);
      return null;
    }

    return filename;
  } catch (err) {
    console.error('[SUPABASE] Upload error:', (err as Error).message);
    return null;
  }
}

/** Public URL builder — ONLY valid for objects in the public bucket. */
export function publicStorageUrl(objectPath: string, bucket: string = PUBLIC_BUCKET): string {
  return `${storageBaseUrl()}/object/public/${bucket}/${objectPath}`;
}

/**
 * Creates a short-lived signed URL for a private object. Returns the
 * fully-qualified URL or null. Callers MUST have already authorized the
 * requester against the file record before calling this.
 */
export async function createSignedStorageUrl(
  objectPath: string,
  expiresInSeconds: number = 300,
  bucket: string = PRIVATE_BUCKET,
): Promise<string | null> {
  const authKey = getSupabaseAuthKey();
  if (!env.SUPABASE_URL || !authKey) return null;

  const ttl = Math.max(30, Math.min(3600, Math.round(expiresInSeconds)));
  try {
    const res = await fetch(`${storageBaseUrl()}/object/sign/${bucket}/${objectPath}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authKey}`,
        'apikey': authKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: ttl }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[SUPABASE] Signed URL failed: ${res.status} — ${body}`);
      return null;
    }
    const data: any = await res.json();
    const signed: string | undefined = data?.signedURL ?? data?.signedUrl;
    if (!signed) return null;
    if (signed.startsWith('http')) return signed;
    return `${storageBaseUrl()}${signed.startsWith('/') ? '' : '/'}${signed}`;
  } catch (err) {
    console.error('[SUPABASE] createSignedStorageUrl error:', (err as Error).message);
    return null;
  }
}

/** Deletes an object. Returns true on success or when it was already gone. */
export async function deleteStorageObject(
  objectPath: string,
  bucket: string = PUBLIC_BUCKET,
): Promise<boolean> {
  const authKey = getSupabaseAuthKey();
  if (!env.SUPABASE_URL || !authKey) return false;

  try {
    const res = await fetch(`${storageBaseUrl()}/object/${bucket}/${objectPath}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${authKey}`, 'apikey': authKey },
    });
    return res.ok || res.status === 404;
  } catch (err) {
    console.error('[SUPABASE] deleteStorageObject error:', (err as Error).message);
    return false;
  }
}
