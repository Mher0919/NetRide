// backend/src/types/optional-modules.d.ts
//
// Type shims for modules that may not have their own declarations.

declare module '@mapbox/polyline' {
  export function decode(encoded: string, precision?: number): Array<[number, number]>;
  export function encode(coords: Array<[number, number]>, precision?: number): string;
}
