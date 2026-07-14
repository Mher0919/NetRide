import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

let supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (supabase) return supabase;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
  return supabase;
}

const BUCKET_NAME = 'uploads';

export async function uploadToSupabase(
  buffer: Buffer,
  filename: string,
  mimetype: string
): Promise<string | null> {
  const client = getSupabase();
  if (!client) return null;

  const { data, error } = await client.storage
    .from(BUCKET_NAME)
    .upload(filename, buffer, {
      contentType: mimetype,
      upsert: false,
    });

  if (error) {
    console.error(`[SUPABASE] Upload error: ${error.message}`);
    return null;
  }

  const { data: urlData } = client.storage
    .from(BUCKET_NAME)
    .getPublicUrl(data.path);

  return urlData?.publicUrl ?? null;
}
