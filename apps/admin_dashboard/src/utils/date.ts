// apps/admin_dashboard/src/utils/date.ts
//
// Drop-in, throw-proof replacement for date-fns `format`.
//
// Call sites across the dashboard pass `new Date(value)` directly into
// `format(...)`. When the underlying value is null, undefined, an empty
// string or malformed (nullable DB timestamps like
// financial_transactions.completed_at / ratings.created_at), `new Date(...)`
// yields an Invalid Date and date-fns throws
// `RangeError: Invalid time value` — which unmounted the whole page behind
// the ErrorBoundary.
//
// This wrapper never throws: invalid input renders the fallback instead.
// Import it instead of 'date-fns' at the call sites.

import { format as dateFnsFormat, isValid } from 'date-fns';

/** True when `value` parses to a valid Date. */
export function isValidDate(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return !Number.isNaN(date.getTime()) && isValid(date);
}

/**
 * Safe `format(value, pattern)`. Accepts the same value types as before
 * (Date, ISO string, epoch millis) and returns `fallback` for anything
 * missing or invalid instead of throwing.
 */
export function format(
  value: Date | number | string | null | undefined,
  pattern: string,
  fallback = '—',
): string {
  if (!isValidDate(value)) return fallback;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return dateFnsFormat(date, pattern);
}
