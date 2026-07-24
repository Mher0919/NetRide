// backend/src/modules/routing/astar-engine-adapter.ts
//
// Adapter that bridges the self-hosted A* routing engine with the existing
// RouteEngine interface.

import { RouteEngine, LocalRoute } from './route-engine';
import { astarEngine } from '../../routing/engine/astar-engine';
import { RoutingError, RoutingErrors } from './routing.errors';
import { logger } from '../../observability/logger';

function isValidCoord(c: unknown): c is [number, number] {
  return (
    Array.isArray(c) &&
    c.length === 2 &&
    typeof c[0] === 'number' &&
    Number.isFinite(c[0]) &&
    typeof c[1] === 'number' &&
    Number.isFinite(c[1]) &&
    c[0] >= -90 && c[0] <= 90 &&
    c[1] >= -180 && c[1] <= 180
  );
}

export const AStarEngineAdapter: RouteEngine = {
  name: 'A*',

  async route(
    origin: [number, number],
    destination: [number, number],
  ): Promise<LocalRoute | null> {
    if (!isValidCoord(origin) || !isValidCoord(destination)) {
      throw new RoutingError(
        RoutingErrors.INVALID_COORDINATES,
        'Invalid coordinates supplied to A* engine',
      );
    }

    if (!astarEngine.isReady()) {
      logger.debug('astar_engine_not_ready_fallback');
      return null;
    }

    try {
      const result = await astarEngine.route(origin, destination);
      if (!result) return null;

      return {
        distanceMeters: result.distanceMeters,
        durationSeconds: result.durationSeconds,
        geometry: result.geometry,
        steps: result.steps,
        speedLimitsByRoad: result.speedLimitsByRoad,
      };
    } catch (err: any) {
      logger.error({ err: err.message }, 'astar_engine_error');
      return null;
    }
  },
};
