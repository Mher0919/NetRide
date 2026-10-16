// backend/scripts/migrate-storage-visibility.cjs
//
// One-shot containment migration for the government-document exposure:
// copies every PRIVATE storage_files object out of the public `uploads`
// bucket into the private `secure-documents` bucket, repoints the DB row,
// then deletes the public copy. Run after migration 057.
//
// Usage:
//   node scripts/migrate-storage-visibility.cjs --dry-run   # report only
//   node scripts/migrate-storage-visibility.cjs             # copy + delete
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment
// (same values the backend uses; loaded from .env via dotenv).
//
// Safety:
//   * Only rows with visibility <> 'public' are touched.
//   * The DB row is repointed ONLY after the private copy uploads
//     successfully, and the public object is deleted ONLY after the DB row
//     is repointed. A crash at any point leaves BOTH copies readable through
//     the authorized endpoint and is safe to re-run.
//   * Profile photos (visibility='public') stay in `uploads`.

require('dotenv').config();
const { Client } = require('pg');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_URL = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
const FALLBACK_DB_URL = process.env.DATABASE_URL;
const PUBLIC_BUCKET = 'uploads';
const PRIVATE_BUCKET = 'secure-documents';
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const storageBase = `${SUPABASE_URL}/storage/v1`;
const authHeaders = { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY };

async function ensurePrivateBucket() {
  const check = await fetch(`${storageBase}/bucket/${PRIVATE_BUCKET}`, { headers: authHeaders });
  if (check.status === 200) return;
  const create = await fetch(`${storageBase}/bucket`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: PRIVATE_BUCKET, name: PRIVATE_BUCKET, public: false }),
  });
  if (!create.ok && create.status !== 409) {
    throw new Error(`Failed to create ${PRIVATE_BUCKET}: ${create.status} ${await create.text()}`);
  }
}

async function copyObject(path) {
  const download = await fetch(`${storageBase}/object/${PUBLIC_BUCKET}/${path}`, { headers: authHeaders });
  if (!download.ok) {
    return { ok: false, reason: `download ${download.status}` };
  }
  const bytes = Buffer.from(await download.arrayBuffer());
  const contentType = download.headers.get('content-type') || 'application/octet-stream';
  const upload = await fetch(`${storageBase}/object/${PRIVATE_BUCKET}/${path}`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': contentType, 'x-upsert': 'true' },
    body: bytes,
  });
  if (!upload.ok) {
    return { ok: false, reason: `upload ${upload.status}` };
  }
  return { ok: true };
}

async function deletePublicObject(path) {
  const res = await fetch(`${storageBase}/object/${PUBLIC_BUCKET}/${path}`, {
    method: 'DELETE',
    headers: authHeaders,
  });
  return res.ok || res.status === 404;
}

(async () => {
  const client = new Client({ connectionString: DB_URL || FALLBACK_DB_URL });
  await client.connect();

  const { rows } = await client.query(
    `SELECT id, path, visibility, storage_bucket
       FROM storage_files
      WHERE bucket = 'supabase'
        AND visibility <> 'public'
        AND COALESCE(storage_bucket, 'uploads') <> $1
      ORDER BY created_at ASC`,
    [PRIVATE_BUCKET],
  );

  console.log(`[migrate-storage] ${rows.length} private object(s) still in the public bucket.`);
  if (DRY_RUN) {
    for (const row of rows) console.log(`  would copy ${row.id} ${row.path}`);
    await client.end();
    return;
  }

  await ensurePrivateBucket();

  let copied = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await copyObject(row.path).catch((err) => ({ ok: false, reason: err.message }));
    if (!result.ok) {
      console.error(`  ❌ ${row.id} (${row.path}): ${result.reason}`);
      failed++;
      continue;
    }
    await client.query(`UPDATE storage_files SET storage_bucket = $1 WHERE id = $2`, [PRIVATE_BUCKET, row.id]);
    const deleted = await deletePublicObject(row.path);
    if (!deleted) {
      console.warn(`  ⚠️ ${row.id}: private copy stored + DB repointed, but public copy could not be deleted — remove it manually.`);
    }
    copied++;
    console.log(`  ✅ ${row.id} -> ${PRIVATE_BUCKET}`);
  }

  console.log(`[migrate-storage] copied ${copied}, failed ${failed}.`);
  await client.end();
  if (failed > 0) process.exit(2);
})().catch((err) => {
  console.error('[migrate-storage] fatal:', err.message);
  process.exit(1);
});
