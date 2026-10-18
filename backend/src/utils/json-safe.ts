// backend/src/utils/json-safe.ts
//
// Deep JSON sanitisation for admin API responses.
//
// Prisma returns `BigInt` for BIGINT columns (money in integer cents) and a
// `Decimal` instance for NUMERIC columns. Express' `res.json` uses
// `JSON.stringify`, which throws `TypeError: Do not know how to serialize a
// BigInt` — converting the whole request into an HTTP 500. A naive recursive
// clone also destroys value types it does not understand (a `Date` has no own
// enumerable properties, so it silently becomes `{}`; a `Decimal` leaks its
// internal `{s,e,d}` representation).
//
// `jsonSafe` converts values to the plain representation the admin dashboard
// expects: BigInt → number (safe while cents < 2^53), Date → ISO string,
// Decimal → number, and only recurses into plain objects/arrays.
export function jsonSafe(value: any): any {
  if (typeof value === 'bigint') {
    // Integer cents / counters stay well inside Number.MAX_SAFE_INTEGER.
    return Number(value);
  }
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'function' || t === 'symbol') return undefined;

  // Dates must survive as dates: JSON.stringify renders them as ISO strings.
  if (value instanceof Date) return value;

  if (Array.isArray(value)) return value.map((v) => jsonSafe(v));

  // Prisma Decimal (decimal.js) — detected by its numeric API. Its own
  // `toJSON` would stringify to "12.34"; the dashboard expects a number.
  if (
    typeof value.toFixed === 'function' &&
    typeof value.toNumber === 'function' &&
    value.constructor !== Date
  ) {
    return Number(value.toString());
  }

  // Buffer / typed arrays must not be exploded key-by-key.
  if (Buffer.isBuffer(value)) return value;

  if (t === 'object') {
    const out: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      const safe = jsonSafe(val);
      if (safe !== undefined) out[key] = safe;
    }
    return out;
  }

  return value;
}
