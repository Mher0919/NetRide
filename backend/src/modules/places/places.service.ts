import { placesRepository, PlaceRow } from './places.repository';
import { query } from '../../config/database';
import { redis } from '../../config/redis';

const SEARCH_CACHE_TTL_S = 300;
const inFlight = new Map<string, Promise<PlaceRow[]>>();

export class PlacesService {

  static async search(
    queryText: string,
    userLat?: number,
    userLon?: number,
  ): Promise<PlaceRow[]> {
    const q = (queryText || '').trim();
    if (!q) return [];

    const lat = Number.isFinite(userLat) ? userLat! : 34.0522;
    const lon = Number.isFinite(userLon) ? userLon! : -118.2437;

    const cacheKey = `places:search:${q.toLowerCase()}:${lat.toFixed(2)}:${lon.toFixed(2)}`;

    const cached = await this.getCache(cacheKey);
    if (cached) return cached;

    const existing = inFlight.get(cacheKey);
    if (existing) return existing;

    const promise = this.executeSearch(q, lat, lon, cacheKey);
    inFlight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(cacheKey);
    }
  }

  private static async executeSearch(
    q: string,
    lat: number,
    lon: number,
    cacheKey: string,
  ): Promise<PlaceRow[]> {
    const results = await placesRepository.searchByTextAndProximity(q, lat, lon);

    if (results.length > 0) {
      await this.setCache(cacheKey, results);
    }

    return results;
  }

  static async getCategories(): Promise<string[]> {
    try {
      const cached = await redis.get('places:categories');
      if (cached) return JSON.parse(cached);
    } catch { /* ignore */ }

    try {
      const result = await query('SELECT DISTINCT category FROM places ORDER BY category', []);
      const categories = result.rows.map((r: any) => r.category);
      await redis.set('places:categories', JSON.stringify(categories), 'EX', 86400);
      return categories;
    } catch {
      return [];
    }
  }

  static async getPlaceCount(): Promise<number> {
    return placesRepository.count();
  }

  private static async getCache(key: string): Promise<PlaceRow[] | null> {
    try {
      const raw = await redis.get(key);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return null;
  }

  private static async setCache(key: string, data: PlaceRow[]): Promise<void> {
    try {
      await redis.set(key, JSON.stringify(data), 'EX', SEARCH_CACHE_TTL_S);
    } catch { /* non-critical */ }
  }
}
