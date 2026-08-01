export interface LocalRoute {
  distanceMeters: number;
  /** Traffic-aware duration (routes.duration under TRAFFIC_AWARE). */
  durationSeconds: number;
  /** Static (no-traffic) duration — stable across time, cacheable 7 days. */
  staticDurationSeconds?: number | null;
  /** Explicit alias of the traffic-aware duration when available. */
  trafficDurationSeconds?: number | null;
  geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
  steps: any[];
  speedLimitsByRoad: Record<string, number>;
}

export interface RouteEngine {
  readonly name: string;
  route(
    origin: [number, number],
    destination: [number, number],
  ): Promise<LocalRoute | null>;
}
