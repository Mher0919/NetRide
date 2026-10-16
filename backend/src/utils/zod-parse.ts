// backend/src/utils/zod-parse.ts
//
// Bounded parsing helpers (CVE-2023-54404 / zod issue #1872).
//
// Zod v4.6.6+ implements an `abortEarly` parse option that stops a container
// at its first aborting issue instead of accumulating one issue object per
// failing input element — a large attacker-supplied array can otherwise
// allocate hundreds of MB of issue objects and OOM the process. The runtime
// supports the option but the published 4.6.7 type definitions do not expose
// the field yet, so the single cast lives here (see colinhacks/zod#6475).

import type { ZodType } from 'zod';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ABORT_EARLY = { abortEarly: true } as any;

export function safeParseBounded<T>(schema: ZodType<T>, data: unknown) {
  return schema.safeParse(data, ABORT_EARLY);
}

export function parseBoundedAsync<T>(schema: ZodType<T>, data: unknown): Promise<T> {
  return schema.parseAsync(data, ABORT_EARLY);
}
