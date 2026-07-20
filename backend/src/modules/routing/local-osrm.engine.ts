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
//   We bake a regional extract (Greater LA) into the image at build time and
//   run the OFFICIAL `osrm-routed` binary as a local sidecar INSIDE the same
//   container (started by the container entrypoint on 127.0.0.1:5000). This
//   process serves the *actual* OSRM road network over HTTP with zero network
//   hop to the outside world, sub-50ms responses, and the same
//   contraction-hierarchy geometry OSRM serves in production. No native Node
//   addon (which is unmaintained/Node-version-fragile) and no second Render
//   service — just one container, one process tree.
//
//   This is the PRIMARY engine. The remote OSRM_URL (if configured) and a
//   road-shaped synthetic fallback are secondary/tertiary only.
//
// Robustness:
//   The engine queries a localhost HTTP endpoint. If osrm-routed isn't up
//   yet (cold start) or the query fails, route() returns null WITHOUT
//   throwing, so callers transparently fall through to the next engine.

import http from 'http';
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

// Local osrm-routed sidecar endpoint (set via OSRM_ROUTED_URL or default).
const OSRM_ROUTED_URL = env.OSRM_ROUTED_URL || 'http://127.0.0.1:5000';

let osrmAvailable = false;
let healthChecked = false;

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

async function getJson(url: string): Promise<any | null> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Probe the local sidecar once. Returns true if it answered a health ping.
 * osrm-routed answers GET / with {"status":"Ok"}.
 */
async function probe(): Promise<boolean> {
  if (healthChecked) return osrmAvailable;
  healthChecked = true;
  const data = await getJson(`${OSRM_ROUTED_URL}/`);
  osrmAvailable = !!data && (data.status === 'Ok' || data.status === 'ok');
  if (osrmAvailable) {
    logger.info({ url: OSRM_ROUTED_URL }, 'routing_osrm_embedded_ready');
  } else {
    logger.warn({ url: OSRM_ROUTED_URL }, 'routing_osrm_embedded_unavailable');
  }
  return osrmAvailable;
}

export const LocalOsrmEngine = {
  /** True once the embedded engine has answered a health probe. */
  get available(): boolean {
    return osrmAvailable;
  },

  /**
   * Compute a driving route via the local osrm-routed sidecar. Returns null
   * (without throwing) if the sidecar is unavailable or the query fails, so
   * callers can transparently fall through to the next engine.
   */
  async route(
    origin: [number, number],
    destination: [number, number],
  ): Promise<LocalOsrmResult | null> {
    if (!(await probe())) return null;

    // OSRM expects lng,lat.
    const coord = `${origin[1]},${origin[0]};${destination[1]},${destination[0]}`;
    const url =
      `${OSRM_ROUTED_URL}/route/v1/driving/${coord}` +
      `?overview=full&geometries=geojson&steps=true&annotations=true`;

    const data = await getJson(url);
    if (!data || !data.routes || !data.routes.length) return null;

    const route = data.routes[0];
    const rawSteps = route.legs?.[0]?.steps ?? [];
    const steps = enrichSteps(rawSteps);

    return {
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      geometry: route.geometry,
      steps,
      speedLimitsByRoad: buildSpeedMap(steps),
    };
  },
};
