import axios, { AxiosInstance } from 'axios';
import http from 'http';
import pThrottle from 'p-throttle';
import { env } from '../../config/env';
import { redis } from '../../config/redis';
import { MLEtaService } from '../../services/ml-eta.service';
import { enrichSteps } from '../../utils/road-classifier';

export interface RouteResponse {
  distance: number;
  osrm_duration: number;
  eta: number;
  geometry: any;
  steps?: any[];
  speedLimitsByRoad?: Record<string, number>;
  cache_hit: boolean;
  model_multiplier: number;
  engine: string;
}

export class GeospatialService {
  private static inFlightRequests = new Map<string, Promise<RouteResponse>>();
  private static isOsrmOnline = false; // Readiness Guard
  
  private static throttler = pThrottle({ limit: 50, interval: 1000 });

  private static axiosClient: AxiosInstance = axios.create({
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 100 }),
    timeout: 2000,
  });

  private static throttledGet = GeospatialService.throttler(async (url: string) => {
    return GeospatialService.axiosClient.get(url);
  });

  static async getRoute(start: [number, number], end: [number, number], isPreCache = false): Promise<RouteResponse> {
    const cacheKey = this.generateCacheKey(start, end);

    // 1. L1 - CACHE LAYER
    const cached = await redis.get(cacheKey);
    if (cached) {
      const result = JSON.parse(cached);
      result.cache_hit = true;
      return result;
    }

    if (this.inFlightRequests.has(cacheKey)) {
      return this.inFlightRequests.get(cacheKey)!;
    }

    const requestStartTime = Date.now();
    const requestPromise = this.fetchAndProcessRoute(start, end, cacheKey, isPreCache ? 5 : 0);
    this.inFlightRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      const totalLatency = Date.now() - requestStartTime;
      if (!isPreCache && this.isOsrmOnline) {
        console.log(`[GEOSPATIAL] ⚡ Request resolved in ${totalLatency}ms (Engine: ${result.engine}, Cache: ${result.cache_hit})`);
      }
      return result;
    } finally {
      this.inFlightRequests.delete(cacheKey);
    }
  }

  static async searchPlaces(query: string, userLat?: number, userLon?: number): Promise<any[]> {
    try {
      // California bounding box (south, north, west, east as Nominatim
      // expects). Slightly looser than the strict CA polygon so we still
      // catch coastal places and Sierra edges that border Nevada/Oregon.
      // Nominatim viewbox is (left, top, right, bottom) i.e. (W, N, E, S).
      const CA_VIEWBOX = '-124.5,42.0,-114.0,32.5';
      const CA_SOUTH = 32.5;
      const CA_NORTH = 42.0;
      const CA_WEST = -124.5;
      const CA_EAST = -114.0;

      const params: any = {
        q: query,
        format: 'json',
        addressdetails: 1,
        limit: 30, // Over-fetch so dedupe + filter still leaves 10+
        viewbox: CA_VIEWBOX,
        bounded: 1, // Strict bounding box
        countrycodes: 'us',
      };

      const response = await this.axiosClient.get('https://nominatim.openstreetmap.org/search', {
        params,
        headers: { 'User-Agent': 'NetRide-Enterprise/1.0' }
      });

      let hits: any[] = Array.isArray(response.data) ? response.data : [];

      // 1. Drop anything Nominatim resolved to a non-CA state. The
      // `addressdetails=1` query puts `state` / `state_code` on each hit.
      const isCalifornia = (h: any) => {
        const a = h.address || {};
        const state = (a.state || '').toString().toLowerCase();
        const code = (a.state_code || a['ISO3166-2-lvl4'] || '').toString().toLowerCase();
        if (state === 'california' || code === 'us-ca' || code === 'ca') return true;
        // Belt-and-braces: verify the point itself falls inside the
        // bounding box (Nominatim sometimes returns a place with a
        // mismatched state when the user typed an ambiguous query).
        const lat = parseFloat(h.lat);
        const lon = parseFloat(h.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          return lat >= CA_SOUTH && lat <= CA_NORTH && lon >= CA_WEST && lon <= CA_EAST;
        }
        return false;
      };

      let results = hits.filter(isCalifornia);

      // 2. Dedupe by (place name + city). Two cafes on opposite corners
      // of the same street shouldn't both appear; keep the closest one.
      const dedupeKey = (h: any) => {
        const a = h.address || {};
        const name = (h.display_name || '').split(',')[0].trim().toLowerCase();
        const city = (a.city || a.town || a.village || a.hamlet || a.suburb || '').toString().toLowerCase();
        return `${name}::${city}`;
      };

      const byKey = new Map<string, any>();
      const haversineMiles = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
        const R = 3958.8;
        const toRad = (d: number) => (d * Math.PI) / 180;
        const dLat = toRad(b.lat - a.lat);
        const dLng = toRad(b.lon - a.lon);
        const x =
          Math.sin(dLat / 2) ** 2 +
          Math.sin(dLng / 2) ** 2 *
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
        return 2 * R * Math.asin(Math.sqrt(x));
      };

      for (const hit of results) {
        const key = dedupeKey(hit);
        if (!key || key === '::') continue;
        const lat = parseFloat(hit.lat);
        const lon = parseFloat(hit.lon);
        const existing = byKey.get(key);
        if (!existing) {
          hit._lat = lat;
          hit._lon = lon;
          byKey.set(key, hit);
          continue;
        }
        // Keep the closer one to the rider (or the first if no rider loc).
        if (userLat !== undefined && userLon !== undefined) {
          const distNew = haversineMiles({ lat, lon }, { lat: userLat, lon: userLon });
          const distExisting = existing._dist_miles ?? Number.POSITIVE_INFINITY;
          if (distNew < distExisting) {
            hit._lat = lat;
            hit._lon = lon;
            byKey.set(key, hit);
          }
        }
      }

      results = Array.from(byKey.values());

      // 3. Score and sort.
      if (userLat !== undefined && userLon !== undefined) {
        for (const r of results) {
          r._dist_miles = haversineMiles(
            { lat: r._lat, lon: r._lon },
            { lat: userLat, lon: userLon }
          );
        }
        results.sort((a, b) => (a._dist_miles ?? 0) - (b._dist_miles ?? 0));
      }

      // 4. Slice to top 10 and tag with `state: 'CA'` so the rider UI
      // can render its "in California" badge.
      return results.slice(0, 10).map((item: any) => ({
        display_name: item.display_name,
        lat: item.lat,
        lon: item.lon,
        type: item.type,
        state: 'CA',
        distance_miles:
          userLat !== undefined && userLon !== undefined
            ? Math.round((item._dist_miles ?? 0) * 10) / 10
            : undefined,
        address: item.address,
      }));
    } catch (err: any) {
      console.error(`[GEOSPATIAL] ❌ Search failed: ${err.message}`);
      return [];
    }
  }

  private static async fetchAndProcessRoute(start: [number, number], end: [number, number], cacheKey: string, retries = 0): Promise<RouteResponse> {
    // If OSRM is not known to be online, skip the attempt and fallback immediately
    if (!this.isOsrmOnline && retries === 0) {
      return this.calculateSyntheticRoute(start, end);
    }

    try {
      const url = `${env.OSRM_URL}/${start[1]},${start[0]};${end[1]},${end[0]}?overview=full&geometries=geojson&steps=true&annotations=true`;
      const response = await this.throttledGet(url);

      if (response.status === 200 && response.data.routes?.length > 0) {
        this.isOsrmOnline = true;
        const route = response.data.routes[0];
        const multiplier = MLEtaService.predictMultiplier(start[0], start[1], route.distance);

        const rawSteps = route.legs?.[0]?.steps ?? [];
        const enrichedSteps = enrichSteps(rawSteps);

        // Build a { road_name | ref → speed_limit_mph } map the speeding
        // detector can resolve a road's limit from in O(1) without
        // re-parsing the steps on every GPS tick.
        const speedLimitsByRoad: Record<string, number> = {};
        for (const step of enrichedSteps) {
          const limit = step.speedLimitMph;
          if (!limit) continue;
          const keys = [step.name, step.ref].filter(k => typeof k === 'string' && k.length > 0);
          for (const k of keys) {
            speedLimitsByRoad[k] = limit;
          }
        }

        const result: RouteResponse = {
          distance: route.distance,
          osrm_duration: route.duration,
          eta: Math.round(route.duration * multiplier),
          geometry: route.geometry,
          steps: enrichedSteps,
          speedLimitsByRoad,
          cache_hit: false,
          model_multiplier: multiplier,
          engine: 'OSRM-ML'
        };

        await redis.set(cacheKey, JSON.stringify(result), 'EX', 600);
        return result;
      }
    } catch (err: any) {
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        return this.fetchAndProcessRoute(start, end, cacheKey, retries - 1);
      }
      
      // If we previously thought it was online but it failed
      if (this.isOsrmOnline) {
        console.error(`[GEOSPATIAL] ❌ OSRM connection lost: ${err.message}`);
        this.isOsrmOnline = false;
      }
    }

    return this.calculateSyntheticRoute(start, end);
  }

  private static generateCacheKey(start: [number, number], end: [number, number]): string {
    const p = 4;
    return `route:${start[0].toFixed(p)}:${start[1].toFixed(p)}:${end[0].toFixed(p)}:${end[1].toFixed(p)}:driving`;
  }

  private static calculateSyntheticRoute(start: [number, number], end: [number, number]): RouteResponse {
    const speed = 6.1;
    const detour = 1.35;
    const lat1 = start[0], lon1 = start[1];
    const lat2 = end[0], lon2 = end[1];
    const R = 6371e3;
    const φ1 = lat1 * Math.PI/180;
    const φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lon2-lon1) * Math.PI/180;
    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distance = R * c * detour;
    const duration = distance / speed;

    return {
      distance,
      osrm_duration: duration,
      eta: Math.round(duration * 1.2),
      geometry: { type: 'LineString', coordinates: [[lon1, lat1], [lon2, lat2]] },
      steps: [],
      speedLimitsByRoad: {},
      cache_hit: false,
      model_multiplier: 1.2,
      engine: 'Synthetic-Fallback'
    };
  }

  static async preCacheHotZones(zones: [number, number][]) {
    console.log('[GEOSPATIAL] OSRM health check started in background...');
    
    let checks = 0;
    const maxChecks = 12; // 1 minute at 5s intervals
    
    // Background health check loop
    const checkInterval = setInterval(async () => {
      checks++;
      try {
        const url = `${env.OSRM_URL.replace('/route/v1/driving', '/nearest/v1/driving')}/${zones[0][1]},${zones[0][0]}?number=1`;
        await this.axiosClient.get(url);
        
        console.log('[GEOSPATIAL] 🟢 OSRM is ready. Triggering LA pre-cache...');
        this.isOsrmOnline = true;
        clearInterval(checkInterval);

        for (const start of zones) {
          for (const end of zones) {
            if (start === end) continue;
            this.getRoute(start, end, true).catch(() => {});
          }
        }
      } catch (e) {
        if (checks >= maxChecks) {
          console.log('[GEOSPATIAL] ℹ️ OSRM still offline. Continuing with synthetic fallback. Pre-caching disabled.');
          clearInterval(checkInterval);
        }
      }
    }, 5000);
  }
}
