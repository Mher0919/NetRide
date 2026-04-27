import axios, { AxiosInstance } from 'axios';
import http from 'http';
import { env } from '../../config/env';
import { redis } from '../../config/redis';
import { MLEtaService } from '../../services/ml-eta.service';

export interface RouteResponse {
  distance: number;
  osrm_duration: number;
  eta: number;
  geometry: any;
  cache_hit: boolean;
  model_multiplier: number;
  engine: string;
}

export class GeospatialService {
  private static inFlightRequests = new Map<string, Promise<RouteResponse>>();
  private static isOsrmOnline = false; // Readiness Guard
  
  private static axiosClient: AxiosInstance = axios.create({
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 100 }),
    timeout: 5000 
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

  private static async fetchAndProcessRoute(start: [number, number], end: [number, number], cacheKey: string, retries = 0): Promise<RouteResponse> {
    // If OSRM is not known to be online, skip the attempt and fallback immediately (saves CPU/Logs)
    if (!this.isOsrmOnline && retries === 0) {
      return this.calculateSyntheticRoute(start, end);
    }

    try {
      const url = `${env.OSRM_URL}/${start[1]},${start[0]};${end[1]},${end[0]}?overview=full&geometries=geojson`;
      const response = await this.axiosClient.get(url);

      if (response.status === 200 && response.data.routes?.length > 0) {
        this.isOsrmOnline = true; // Set global flag on first success
        const route = response.data.routes[0];
        const multiplier = MLEtaService.predictMultiplier(start[0], start[1], route.distance);
        
        const result: RouteResponse = {
          distance: route.distance,
          osrm_duration: route.duration,
          eta: Math.round(route.duration * multiplier),
          geometry: route.geometry,
          cache_hit: false,
          model_multiplier: multiplier,
          engine: 'OSRM-ML'
        };

        await redis.set(cacheKey, JSON.stringify(result), 'EX', 300);
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
      cache_hit: false,
      model_multiplier: 1.2,
      engine: 'Synthetic-Fallback'
    };
  }

  static async preCacheHotZones(zones: [number, number][]) {
    console.log('[GEOSPATIAL] Waiting for OSRM to load into RAM...');
    
    // Background health check loop
    const checkInterval = setInterval(async () => {
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
        // Silently wait
      }
    }, 5000);
  }
}
