// apps/admin_dashboard/src/utils/safeUrl.ts
//
// Defense-in-depth for opening backend-supplied URLs (driver documents,
// evidence photos, verification images). Those values originate from
// user-controlled uploads/API fields, so a javascript:, data:, or file:
// URL must never reach window.open — that would be a stored-XSS vector in
// the admin's authenticated session. Only http(s) (including same-origin
// relative /api/files/... paths) are opened, always with noopener.

export function openSafeExternalUrl(url: unknown, target = '_blank'): boolean {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;

  let resolved: URL;
  try {
    resolved = new URL(trimmed, window.location.origin);
  } catch {
    return false;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return false;
  }

  window.open(resolved.href, target, 'noopener,noreferrer');
  return true;
}

/**
 * Opens the document URL(s) stored on a resubmission row. The value is
 * either a single URL or a JSON-encoded array (legacy rows), so parsing is
 * wrapped and every entry passes the same scheme allowlist.
 */
export function openSafeExternalUrls(raw: unknown): void {
  if (typeof raw !== 'string' || !raw) return;

  let values: unknown[] = [raw];
  if (raw.trimStart().startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      values = Array.isArray(parsed) ? parsed : [];
    } catch {
      return;
    }
  }
  for (const value of values) openSafeExternalUrl(value);
}
