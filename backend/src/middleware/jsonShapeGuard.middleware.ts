// backend/src/middleware/jsonShapeGuard.middleware.ts
//
// Boundary guard for JSON/urlencoded request bodies (CVE-2023-54404 class):
// a body with an attacker-controlled number of array elements or nesting
// levels can make validation allocate one issue object per failing element
// (hundreds of MB from a few-MB body) and crash the process. `express.json`'s
// byte limit does not bound element count, so reject absurd shapes before any
// schema runs. The limits are deliberately far above real NetRide payloads
// (largest legitimate array is 100 notification ids; largest object is an
// onboarding profile) so no valid traffic is affected.

import { Request, Response, NextFunction } from 'express';

export interface JsonShapeLimits {
  maxDepth: number;
  maxArrayLength: number;
  maxObjectKeys: number;
}

export const DEFAULT_JSON_SHAPE_LIMITS: JsonShapeLimits = Object.freeze({
  maxDepth: 32,
  maxArrayLength: 10_000,
  maxObjectKeys: 5_000,
});

/**
 * Iterative walk (no recursion: the payload is the untrusted input). Returns
 * a human-readable reason when the value exceeds a limit, otherwise null.
 */
export function findShapeViolation(
  value: unknown,
  limits: JsonShapeLimits = DEFAULT_JSON_SHAPE_LIMITS,
): string | null {
  if (value === null || typeof value !== 'object') return null;

  const stack: Array<{ node: object; depth: number }> = [
    { node: value as object, depth: 1 },
  ];

  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;

    if (Array.isArray(node)) {
      if (node.length > limits.maxArrayLength) {
        return `array exceeds ${limits.maxArrayLength} elements`;
      }
      if (depth >= limits.maxDepth && node.length > 0) {
        return `payload nesting exceeds ${limits.maxDepth} levels`;
      }
      for (const child of node) {
        if (child !== null && typeof child === 'object') {
          stack.push({ node: child, depth: depth + 1 });
        }
      }
    } else {
      const record = node as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.length > limits.maxObjectKeys) {
        return `object exceeds ${limits.maxObjectKeys} keys`;
      }
      if (depth >= limits.maxDepth && keys.length > 0) {
        return `payload nesting exceeds ${limits.maxDepth} levels`;
      }
      for (const key of keys) {
        const child = record[key];
        if (child !== null && typeof child === 'object') {
          stack.push({ node: child, depth: depth + 1 });
        }
      }
    }
  }

  return null;
}

export function jsonShapeGuard(limits: JsonShapeLimits = DEFAULT_JSON_SHAPE_LIMITS) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.body || typeof req.body !== 'object') return next();
    if (!req.is('application/json') && !req.is('application/x-www-form-urlencoded')) {
      return next();
    }
    if (findShapeViolation(req.body, limits)) {
      // 413 keeps this consistent with the body-size limit.
      return res.status(413).json({
        error: 'Request payload is too large or too deeply nested.',
      });
    }
    next();
  };
}
