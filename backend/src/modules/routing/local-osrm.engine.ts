// backend/src/modules/routing/local-osrm.engine.ts
//
// Embedded, in-process OSRM engine.
//
// Why this exists (architecture):
//   A separate routing microservice (or a paid hosted API) is the classic
//   way to get Google-level road geometry — but it is heavy, another thing
//   to keep alive, and on a free-tier host (Render free) a second always-on
//   service is both expensive and flaky (cold starts, sleep).
//
//   @osrm/osrm runs the *actual* OSRM routing core inside the Node process.
//   No network hop, no second service, sub-50ms responses, and the geometry
//   is the same contraction-hierarchy road network OSRM serves over HTTP.
//   We bake a regional extract (Greater LA / SoCal) into the image at build
//   time, so the working set is a single ~40–80MB .osrm file — trivial for
//   the free tier and effectively zero marginal cost per request.
//
//   This is the PRIMARY engine. The remote OSRM_URL (if configured) and a
//   road-shaped synthetic fallback are secondary/tertiary only.
//
// Native-build safety:
//   @osrm/osrm ships a native addon. We NEVER import it statically — it is
//   required lazily inside an async method, wrapped in try/catch, so that a
//   missing/!buildable native module can never break `npm install`, `tsc`,
//   tests, or the server boot on platforms where it isn't available. On the
//   production Linux image (where the .osrm is baked) it loads normally.

import { env } from '../../config/env';
import { MLEtaService } from '../../services/ml-eta.service';
import { enrichSteps } from '../../utils/road-classifier';
import { logger } from '../../observability/logger';

export interface LocalOsrmResult {
  distanceMeters: number;
  durationSeconds: number;
  geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
  steps: any[];
  speedLimitsByRoad: Record<string, number>;
}

// Singleton handle to the loaded OSRM instance (null until first success).
let osrmInstance: any = null;
let osrmLoadAttempted = false;
let osrmAvailable = false;

/** Absolute/relative path to the baked regional .osrm extract. */
const OSRM_DATA_PATH = env.OSRM_DATA_PATH || './data/la.osrm';

/**
 * Lazily load (once) the in-process OSRM engine for the SoCal road network.
 * Returns the engine instance or null if it can't be loaded. Never throws.
 */
async function loadOsrm(): Promise<any | null> {
  if (osrmLoadAttempted) return osrmAvailable ? osrmInstance : null;
  osrmLoadAttempted = true;

  try {
    // Dynamic import keeps the native addon out of the static dependency
    // graph so the build/tests never require it to be compiled.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = await import('@osrm/osrm');
    const Osrm = (mod as any).default ?? mod;
    osrmInstance = new Osrm({
      path: OSRM_DATA_PATH,
      algorithm: 'CH',
    });
    // Warm the file handle — the constructor is sync but the mmap can surface
    // errors on first use, so we probe with a tiny query.
    await new Promise<void>((resolve, reject) => {
      osrmInstance.route(
        {
          coordinates: [
            [-118.2437, 34.0522], // Los Angeles
            [-118.25, 34.06],
          ],
          overview: 'full',
          geometry: 'geojson',
          steps: true,
          annotations: true,
        },
        (err: any) => (err ? reject(err) : resolve()),
      );
    });
    osrmAvailable = true;
    logger.info({ path: OSRM_DATA_PATH }, 'routing_osrm_embedded_ready');
    return osrmInstance;
  } catch (err: any) {
    osrmAvailable = false;
    logger.warn(
      { err: err?.message, path: OSRM_DATA_PATH },
      'routing_osrm_embedded_unavailable',
    );
    return null;
  }
}

export const LocalOsrmEngine = {
  /** True once the embedded engine has loaded successfully. */
  get available(): boolean {
    return osrmAvailable;
  },

  /**
   * Compute a driving route entirely in-process. Returns null (without
   * throwing) if the engine is unavailable or the query fails, so callers
   * can transparently fall through to the next engine.
   */
  async route(
    origin: [number, number],
    destination: [number, number],
  ): Promise<LocalOsrmResult | null> {
    const osrm = await loadOsrm();
    if (!osrm) return null;

    // OSRM expects [lng, lat].
    const coordinates: [number, number][] = [
      [origin[1], origin[0]],
      [destination[1], destination[0]],
    ];

    const result = await new Promise<any>((resolve, reject) => {
      osrm.route(
        {
          coordinates,
          overview: 'full',
          geometry: 'geojson',
          steps: true,
          annotations: true,
        },
        (err: any, res: any) => (err ? reject(err) : resolve(res)),
      );
    }).catch(() => null);

    if (!result || !result.routes || !result.routes.length) return null;

    const route = result.routes[0];
    const distanceMeters = route.distance;
    const osrmDuration = route.duration;
    const multiplier = MLEtaService.predictMultiplier(origin[0], origin[1], distanceMeters);
    const rawSteps = route.legs?.[0]?.steps ?? [];
    const steps = enrichSteps(rawSteps);
    const speedLimitsByRoad = buildSpeedMap(steps);

    return {
      distanceMeters,
      durationSeconds: osrmDuration,
      geometry: route.geometry,
      steps,
      speedLimitsByRoad,
    };
  },
};

function buildSpeedMap(steps: any[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const step of steps) {
    const limit = step.speedLimitMph;
    if (!limit) continue;
    const keys = [step.name, step.ref].filter(
      (k) => typeof k === 'string' && k.length > 0,
    );
    for (const k of keys) map[k] = limit;
  }
  return map;
}
