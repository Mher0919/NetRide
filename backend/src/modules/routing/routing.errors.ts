// backend/src/modules/routing/routing.errors.ts
//
// Typed routing errors so controllers can map them to precise HTTP statuses
// (400 for bad input, 502 for upstream failure) instead of a generic 500.

export const RoutingErrors = {
  INVALID_COORDINATES: 'INVALID_COORDINATES',
  ENGINE_UNAVAILABLE: 'ENGINE_UNAVAILABLE',
} as const;

export type RoutingErrorCode = (typeof RoutingErrors)[keyof typeof RoutingErrors];

export class RoutingError extends Error {
  public readonly code: RoutingErrorCode;
  constructor(code: RoutingErrorCode, message: string) {
    super(message);
    this.name = 'RoutingError';
    this.code = code;
  }
}
