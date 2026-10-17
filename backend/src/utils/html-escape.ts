// backend/src/utils/html-escape.ts
//
// Context-correct escaping for HTML email templates. Every value that
// originates from a user, database row or operator input MUST pass through
// escapeHtml before being interpolated into an HTML body/attribute.

/** HTML text/attribute escaping. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** URL-path/query escaping for identifiers embedded in links. */
export function encodeUrlPart(value: unknown): string {
  return encodeURIComponent(String(value ?? ''));
}
