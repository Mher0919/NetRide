// backend/src/routing/utils/cache.ts
//
// LRU cache for A* routing results. Caches snapped nodes, route results,
// and frequently requested OD pairs. Pure in-memory implementation with
// optional Redis backing for distributed caching.

import { RouteResult } from '../graph/types';

interface CacheEntry<T> {
  value: T;
  timestamp: number;
  accessCount: number;
}

/**
 * Simple LRU cache with TTL support.
 */
export class LRUCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxSize: number;
  private defaultTTL: number;

  constructor(maxSize: number = 10000, defaultTTLSeconds: number = 600) {
    this.maxSize = maxSize;
    this.defaultTTL = defaultTTLSeconds * 1000;
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp >= this.defaultTTL) {
      this.cache.delete(key);
      return null;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    entry.accessCount++;
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    // Delete if exists (to move to end)
    this.cache.delete(key);

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      accessCount: 0,
    });
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  /** Get cache statistics. */
  stats(): { size: number; maxSize: number; hitRate: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: 0, // Would need hit/miss counters for real stats
    };
  }
}

/**
 * Route-specific cache with geohash-based nearby lookup.
 * Supports exact-match and nearby OD pair reuse.
 */
export class RouteCache {
  private exactCache: LRUCache<RouteResult>;
  private nearbyCache: LRUCache<RouteResult>;
  private snapCache: LRUCache<number>;

  constructor() {
    this.exactCache = new LRUCache<RouteResult>(5000, 600);   // 10min TTL
    this.nearbyCache = new LRUCache<RouteResult>(3000, 300);   // 5min TTL
    this.snapCache = new LRUCache<number>(10000, 3600);    // 1hr TTL
  }

  /** Generate exact cache key for OD pair. */
  private exactKey(oLat: number, oLng: number, dLat: number, dLng: number): string {
    return `r:${oLat.toFixed(4)}:${oLng.toFixed(4)}:${dLat.toFixed(4)}:${dLng.toFixed(4)}`;
  }

  /** Generate geohash-like key for nearby lookup. */
  private nearbyKey(oLat: number, oLng: number, dLat: number, dLng: number): string {
    // Round to ~100m grid
    const p = 3;
    return `n:${oLat.toFixed(p)}:${oLng.toFixed(p)}:${dLat.toFixed(p)}:${dLng.toFixed(p)}`;
  }

  /** Get cached route (exact match first, then nearby). */
  getRoute(oLat: number, oLng: number, dLat: number, dLng: number): RouteResult | null {
    const exact = this.exactCache.get(this.exactKey(oLat, oLng, dLat, dLng));
    if (exact) return exact;

    const nearby = this.nearbyCache.get(this.nearbyKey(oLat, oLng, dLat, dLng));
    if (nearby) {
      // Promote to exact cache
      this.exactCache.set(this.exactKey(oLat, oLng, dLat, dLng), nearby);
      return nearby;
    }

    return null;
  }

  /** Cache a route result. */
  setRoute(oLat: number, oLng: number, dLat: number, dLng: number, route: RouteResult): void {
    this.exactCache.set(this.exactKey(oLat, oLng, dLat, dLng), route);
    this.nearbyCache.set(this.nearbyKey(oLat, oLng, dLat, dLng), route);
  }

  /** Get cached snapped node index. */
  getSnapNode(lat: number, lng: number): number | null {
    return this.snapCache.get(`snap:${lat.toFixed(5)}:${lng.toFixed(5)}`) ?? null;
  }

  /** Cache a snapped node index. */
  setSnapNode(lat: number, lng: number, nodeIndex: number): void {
    this.snapCache.set(`snap:${lat.toFixed(5)}:${lng.toFixed(5)}`, nodeIndex);
  }

  /** Get lightweight distance-only result (for price estimation). */
  getLightweight(oLat: number, oLng: number, dLat: number, dLng: number): { distanceMeters: number; durationSeconds: number } | null {
    const key = `lw:${oLat.toFixed(4)}:${oLng.toFixed(4)}:${dLat.toFixed(4)}:${dLng.toFixed(4)}`;
    return this.exactCache.get(key) as any ?? null;
  }

  /** Cache lightweight distance-only result. */
  setLightweight(oLat: number, oLng: number, dLat: number, dLng: number, result: { distanceMeters: number; durationSeconds: number }): void {
    const key = `lw:${oLat.toFixed(4)}:${oLng.toFixed(4)}:${dLat.toFixed(4)}:${dLng.toFixed(4)}`;
    this.exactCache.set(key, result as any);
  }

  clear(): void {
    this.exactCache.clear();
    this.nearbyCache.clear();
    this.snapCache.clear();
  }

  stats(): { exact: { size: number; maxSize: number }; nearby: { size: number; maxSize: number }; snap: { size: number; maxSize: number } } {
    return {
      exact: this.exactCache.stats(),
      nearby: this.nearbyCache.stats(),
      snap: this.snapCache.stats(),
    };
  }
}
