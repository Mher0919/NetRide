export interface LocalRoute {
  distanceMeters: number;
  durationSeconds: number;
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
