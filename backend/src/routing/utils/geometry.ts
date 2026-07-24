// backend/src/routing/utils/geometry.ts
//
// Polyline encoding/decoding and geometry utilities for the A* routing engine.
// Uses the @mapbox/polyline library for encoding/decoding (precision 5 for lat/lng).

// eslint-disable-next-line @typescript-eslint/no-var-requires
const polylineLib = require('@mapbox/polyline');

/**
 * Encode an array of [lat, lng] coordinates into an encoded polyline string.
 * Uses precision 5 (1e-5 degree resolution ≈ 1.1m).
 */
export function encodePolyline(coordinates: Array<[number, number]>): string {
  return polylineLib.encode(coordinates, 5);
}

/**
 * Decode an encoded polyline string back to [lat, lng] coordinates.
 */
export function decodePolyline(encoded: string, precision: number = 5): Array<[number, number]> {
  if (!encoded || encoded.length === 0) return [];
  return polylineLib.decode(encoded, precision);
}

/**
 * Simplify a polyline using the Ramer-Douglas-Peucker algorithm.
 * Reduces point count while preserving overall shape.
 */
export function simplifyPolyline(
  coords: Array<[number, number]>,
  tolerance: number = 0.00001,
): Array<[number, number]> {
  if (coords.length <= 2) return coords;

  let maxDist = 0;
  let maxIdx = 0;
  const first = coords[0];
  const last = coords[coords.length - 1];

  for (let i = 1; i < coords.length - 1; i++) {
    const d = pointToLineDistance(coords[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > tolerance) {
    const left = simplifyPolyline(coords.slice(0, maxIdx + 1), tolerance);
    const right = simplifyPolyline(coords.slice(maxIdx), tolerance);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}

function pointToLineDistance(
  point: [number, number],
  lineStart: [number, number],
  lineEnd: [number, number],
): number {
  const [px, py] = point;
  const [ax, ay] = lineStart;
  const [bx, by] = lineEnd;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}

/**
 * Generate a GeoJSON LineString geometry from coordinates.
 */
export function toGeoJSONLineString(
  coords: Array<[number, number]>,
): { type: 'LineString'; coordinates: Array<[number, number]> } {
  // GeoJSON uses [lng, lat] order
  return {
    type: 'LineString',
    coordinates: coords.map(([lat, lng]) => [lng, lat]),
  };
}

/**
 * Calculate the total distance of a polyline in meters.
 */
export function polylineDistance(coords: Array<[number, number]>): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineMeters(coords[i - 1], coords[i]);
  }
  return total;
}

export function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/**
 * Calculate bearing from point a to point b in degrees (0-360).
 */
export function bearing(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const dLng = toRad(b[1] - a[1]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
