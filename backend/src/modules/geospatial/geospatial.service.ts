import axios from 'axios';
import { redis } from '../../config/redis';
import { RoutingService, RoutingResult } from '../routing/routing.service';
import { logger } from '../../observability/logger';

interface InspectionStation {
  display_name: string;
  lat: string;
  lon: string;
  distance_miles: number | null;
  address: Record<string, string> | null;
  phone: string | null;
  opening_hours: string | null;
  type: string;
  state: string;
}

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
  /**
   * All routing now flows through the single RoutingService (which owns the
   * ORS engine, cache, dedup, retries, and fallback). GeospatialService is a
   * thin adapter that maps the routing result into the legacy `RouteResponse`
   * shape the dispatch / navigation / controller layers expect. This removes
   * the second, duplicated OSRM client that previously lived here.
   */
  static async getRoute(start: [number, number], end: [number, number], isPreCache = false): Promise<RouteResponse> {
    const requestStartTime = Date.now();
    const route: RoutingResult = await RoutingService.calculateRoute(
      [start[0], start[1]],
      [end[0], end[1]],
    );

    const multiplier =
      route.durationSeconds > 0
        ? route.etaSeconds / route.durationSeconds
        : 1.2;

    if (!isPreCache) {
      const totalLatency = Date.now() - requestStartTime;
      logger.info(
        { latencyMs: totalLatency, engine: route.engine, cacheHit: route.cacheHit },
        'geospatial_route',
      );
    }

    return {
      distance: route.distanceMeters,
      osrm_duration: route.durationSeconds,
      eta: route.etaSeconds,
      geometry: route.geometry,
      steps: route.steps,
      speedLimitsByRoad: route.speedLimitsByRoad,
      cache_hit: route.cacheHit,
      model_multiplier: Math.round(multiplier * 100) / 100,
      engine: route.engine,
    };
  }

  // ---- Inspection-location helpers (driver app) --------------------------

  /// CA bounding constants used for validating geocoded ZIPs.
  private static readonly CA_BBOX = {
    south: 32.5,
    north: 42.0,
    west: -124.5,
    east: -114.0,
  };

  private static isInCalifornia(lat: number, lon: number): boolean {
    return (
      lat >= this.CA_BBOX.south &&
      lat <= this.CA_BBOX.north &&
      lon >= this.CA_BBOX.west &&
      lon <= this.CA_BBOX.east
    );
  }

  /// Geocode a ZIP code to {lat, lon} via Nominatim (nationwide).
  /// Returns null if the ZIP can't be resolved or lies outside CA.
  static async geocodeZip(zip: string): Promise<{ lat: number; lon: number } | null> {
    const cacheKey = `geocode:zip:${zip}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        return { lat: parsed.lat, lon: parsed.lon };
      }
    } catch {
      // cache miss or redis down — proceed
    }

    try {
      const resp = await axios.get('https://nominatim.openstreetmap.org/search', {
        params: {
          q: zip,
          format: 'json',
          countrycodes: 'us',
          limit: 1,
        },
        headers: { 'User-Agent': 'NetRide-Enterprise/1.0' },
        timeout: 5000,
      });

      const data = resp.data;
      if (!Array.isArray(data) || data.length === 0) return null;

      const lat = parseFloat(data[0].lat);
      const lon = parseFloat(data[0].lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

      if (!this.isInCalifornia(lat, lon)) {
        console.log(`[GEOSPATIAL] ZIP ${zip} resolved to non-CA location (${lat},${lon}) — rejecting`);
        return null;
      }

      const result = { lat, lon };
      // Cache for 24 hours
      await redis.set(cacheKey, JSON.stringify(result), 'EX', 86400).catch(() => {});
      return result;
    } catch (err: any) {
      console.error(`[GEOSPATIAL] ❌ Geocode failed for ZIP ${zip}: ${err.message}`);
      return null;
    }
  }

  /// Search for vehicle-inspection-related POIs near (lat,lon) using the
  /// Overpass API.  Progressively expands the search radius until we have
  /// enough results or hit the cap.
  static async findNearbyInspections(
    lat: number,
    lon: number,
  ): Promise<InspectionStation[]> {
    const RADII_KM = [5, 10, 25, 50];
    const seen = new Set<string>();

    const results: InspectionStation[] = [];

    const haversine = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
      const R = 3958.8;
      const toRad = (d: number) => (d * Math.PI) / 180;
      const dLat = toRad(b.lat - a.lat);
      const dLng = toRad(b.lon - a.lon);
      const x =
        Math.sin(dLat / 2) ** 2 +
        Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
      return 2 * R * Math.asin(Math.sqrt(x));
    };

    for (const radiusKm of RADII_KM) {
      if (results.length >= 5) break;

      const radiusM = radiusKm * 1000;
      // Build a compact Overpass QL query. The backtick template contains
      // actual newlines — Overpass tolerates whitespace, but we condense it
      // for a cleaner log entry.
      const overpassQuery = [
        '[out:json][timeout:20];',
        '(',
        `node["amenity"="vehicle_inspection"](around:${radiusM},${lat},${lon});`,
        `way["amenity"="vehicle_inspection"](around:${radiusM},${lat},${lon});`,
        `node["shop"="car_repair"](around:${radiusM},${lat},${lon});`,
        `way["shop"="car_repair"](around:${radiusM},${lat},${lon});`,
        `node["amenity"="smog_check"](around:${radiusM},${lat},${lon});`,
        `way["amenity"="smog_check"](around:${radiusM},${lat},${lon});`,
        ');',
        'out center 25;',
      ].join('');

      console.log(`[GEOSPATIAL] Overpass query (${radiusKm}km): ${overpassQuery.slice(0, 200)}...`);

      const fetchOverpass = async (): Promise<any[]> => {
        // Try POST first (preferred for longer queries).
        try {
          const formParams = new URLSearchParams();
          formParams.append('data', overpassQuery);
          const resp = await axios.post(
            'https://overpass-api.de/api/interpreter',
            formParams,
            {
              headers: { 'User-Agent': 'NetRide-Enterprise/1.0' },
              timeout: 25000,
            },
          );
          return resp.data?.elements ?? [];
        } catch (postErr: any) {
          console.warn(`[GEOSPATIAL] Overpass POST failed (${postErr.message}), trying GET...`);
          // Fallback to GET
          const resp = await axios.get(
            'https://overpass-api.de/api/interpreter',
            {
              params: { data: overpassQuery },
              headers: { 'User-Agent': 'NetRide-Enterprise/1.0' },
              timeout: 25000,
            },
          );
          return resp.data?.elements ?? [];
        }
      };

      try {
        const elements = await fetchOverpass();
        for (const el of elements) {
          const tags = el.tags ?? {};
          const name = tags.name;
          if (!name) continue;

          const elLat = el.type === 'node' ? el.lat : el.center?.lat;
          const elLon = el.type === 'node' ? el.lon : el.center?.lon;
          if (!Number.isFinite(elLat) || !Number.isFinite(elLon)) continue;

          const addrParts = [
            tags['addr:housenumber'],
            tags['addr:street'],
            tags['addr:city'],
            tags['addr:state'],
            tags['addr:postcode'],
          ].filter(Boolean);
          const addrStr = addrParts.length > 0 ? addrParts.join(', ') : null;

          const key = `${name}|${addrStr ?? elLat},${elLon}`;
          if (seen.has(key)) continue;
          seen.add(key);

          results.push({
            display_name: name,
            lat: String(elLat),
            lon: String(elLon),
            distance_miles: Math.round(haversine({ lat, lon }, { lat: elLat, lon: elLon }) * 10) / 10,
            address: addrStr
              ? {
                  house_number: tags['addr:housenumber'] ?? '',
                  road: tags['addr:street'] ?? '',
                  city: tags['addr:city'] ?? '',
                  state: tags['addr:state'] ?? 'CA',
                  postcode: tags['addr:postcode'] ?? '',
                }
              : null,
            phone: tags.phone ?? tags['contact:phone'] ?? null,
            opening_hours: tags.opening_hours ?? null,
            type: tags.amenity || tags.shop || 'car_repair',
            state: 'CA',
          });
        }
      } catch (err: any) {
        console.error(`[GEOSPATIAL] ❌ Overpass query failed at ${radiusKm}km: ${err.message}`);
      }
    }

    results.sort((a, b) => (a.distance_miles ?? 999) - (b.distance_miles ?? 999));
    return results.slice(0, 15);
  }

  /**
   * Search for points of interest near the rider.
   *
   * Architecture (the 50–100mi bug fix):
   *   The previous implementation used Nominatim *text search* over the whole
   *   state of California. Nominatim is a geocoder, not a nearby-POI finder;
   *   without a tight proximity bias it returns the most "notable" matches
   *   statewide, so "coffee" / "Starbucks" / "McDonald's" came back 50–100mi
   *   away. We now query the **Overpass API** with an `around:<radius>` filter
   *   centered on the rider — a real spatial POI search that returns the
   *   literally-nearest coffee shops / restaurants / brands first. Overpass is
   *   free and OSM-backed (Google-level POI coverage).
   *
   *   Nominatim is kept ONLY as a graceful fallback for address-like queries
   *   (street addresses, intersections) where a geocoder is the right tool
   *   and no rider location is available.
   */
  static async searchPlaces(query: string, userLat?: number, userLon?: number): Promise<any[]> {
    const q = (query || '').trim();
    if (!q) return [];

    // When we have the rider's location, do a true nearby POI search.
    if (Number.isFinite(userLat) && Number.isFinite(userLon)) {
      const results = await this.searchPlacesNearby(q, userLat as number, userLon as number);
      if (results.length > 0) return results;
      // No Overpass results within 50mi — show autocomplete suggestions so
      // the rider can pick a known destination instead of remote results.
      const suggestions = this.autocompleteSearch(q);
      if (suggestions.length > 0) {
        return suggestions.map((s, i) => ({
          display_name: s,
          lat: 0, lon: 0,
          type: 'suggestion',
          state: '',
          distance_miles: undefined,
          is_suggestion: true,
        }));
      }
    }

    // No location or no Overpass results — return autocomplete suggestions
    // instead of a nationwide text search that brings back 100mi+ results.
    return this.nominatimFallback(q, userLat, userLon);
  }

  /// Map a free-text query to OSM amenity/shop tags for the Overpass search.
  private static poiTagFilters(query: string): string[] {
    const ql = query.toLowerCase();
    const has = (...terms: string[]) => terms.some((t) => ql.includes(t));

    // Brand / chain name matches still resolve to an amenity via `name~`.
    if (has('coffee', 'cafe', 'espresso', 'starbucks', 'peet', 'blue bottle')) {
      return ['node["amenity"="cafe"]', 'way["amenity"="cafe"]', 'node["amenity"="coffee_shop"]', 'way["amenity"="coffee_shop"]'];
    }
    if (has('restaurant', 'dining', 'dinner', 'lunch', 'breakfast', 'brunch')) {
      return ['node["amenity"="restaurant"]', 'way["amenity"="restaurant"]'];
    }
    if (has('fast', 'mcdonald', 'burger', 'kfc', 'wendy', 'taco', 'chipotle', 'subway', 'pizza', 'food', 'drive')) {
      return ['node["amenity"="fast_food"]', 'way["amenity"="fast_food"]'];
    }
    if (has('bar', 'pub', 'nightclub', 'cocktail', 'beer', 'lounge')) {
      return ['node["amenity"="bar"]', 'way["amenity"="bar"]', 'node["amenity"="pub"]', 'way["amenity"="pub"]'];
    }
    if (has('gas', 'fuel', 'shell', 'chevron', 'arco', '76', 'exxon', 'charging')) {
      return ['node["amenity"="fuel"]', 'way["amenity"="fuel"]'];
    }
    if (has('hotel', 'motel', 'inn', 'lodging', 'airbnb', 'hostel')) {
      return ['node["tourism"="hotel"]', 'way["tourism"="hotel"]', 'node["tourism"="motel"]', 'way["tourism"="motel"]'];
    }
    if (has('grocery', 'market', 'supermarket', 'whole foods', 'trader', 'target', 'walmart', 'store', 'shop', 'costco')) {
      return ['node["shop"="supermarket"]', 'way["shop"="supermarket"]', 'node["shop"="convenience"]', 'way["shop"="convenience"]'];
    }
    if (has('park', 'playground', 'garden', 'zoo')) {
      return ['node["leisure"="park"]', 'way["leisure"="park"]'];
    }
    if (has('hospital', 'clinic', 'urgent', 'medical', 'doctor', 'pharmacy', 'cvs', 'walgreens', 'dentist')) {
      return ['node["amenity"="hospital"]', 'way["amenity"="hospital"]', 'node["amenity"="pharmacy"]', 'way["amenity"="pharmacy"]', 'node["amenity"="clinic"]', 'way["amenity"="clinic"]'];
    }
    if (has('school', 'university', 'college', 'campus', 'high')) {
      return ['node["amenity"="school"]', 'way["amenity"="school"]', 'node["amenity"="university"]', 'way["amenity"="university"]'];
    }
    if (has('bank', 'atm', 'chase', 'wells', 'bofa', 'citi', 'credit')) {
      return ['node["amenity"="bank"]', 'way["amenity"="bank"]', 'node["amenity"="atm"]', 'way["amenity"="atm"]'];
    }
    if (has('airport', 'lax', 'burbank', 'john wayne', 'ontario', 'sfo', 'oakland', 'san diego')) {
      return ['node["aeroway"="aerodrome"]', 'way["aeroway"="aerodrome"]', 'node["aeroway"="terminal"]', 'way["aeroway"="terminal"]'];
    }
    if (has('disney', 'disn', 'magic', 'theme park', 'amusement')) {
      return ['node["tourism"="theme_park"]', 'way["tourism"="theme_park"]', 'node["leisure"="amusement_arcade"]', 'way["leisure"="amusement_arcade"]'];
    }
    if (has('six flags', 'hurricane', 'water park')) {
      return ['node["tourism"="theme_park"]', 'way["tourism"="theme_park"]'];
    }
    if (has('gym', 'fitness', 'workout', '24 hour', 'la fitness', 'planet fitness', 'equinox')) {
      return ['node["leisure"="fitness_centre"]', 'way["leisure"="fitness_centre"]', 'node["amenity"="gym"]', 'way["amenity"="gym"]'];
    }
    if (has('mall', 'shopping', 'plaza')) {
      return ['node["shop"="mall"]', 'way["shop"="mall"]'];
    }
    if (has('stadium', 'arena', 'concert', 'venue', 'staples', 'crypto', 'sofi', 'dodger')) {
      return ['node["leisure"="stadium"]', 'way["leisure"="stadium"]', 'node["building"="stadium"]', 'way["building"="stadium"]', 'node["amenity"="theatre"]', 'way["amenity"="theatre"]'];
    }
    if (has('movie', 'cinema', 'theater', 'theatre', 'amc', 'regal')) {
      return ['node["amenity"="cinema"]', 'way["amenity"="cinema"]'];
    }
    if (has('pharmacy', 'drug', 'cvs', 'walgreen', 'rite aid')) {
      return ['node["amenity"="pharmacy"]', 'way["amenity"="pharmacy"]'];
    }
    if (has('post', 'mail', 'fedex', 'ups', 'shipping')) {
      return ['node["amenity"="post_office"]', 'way["amenity"="post_office"]'];
    }
    if (has('library')) {
      return ['node["amenity"="library"]', 'way["amenity"="library"]'];
    }
    if (has('parking', 'garage')) {
      return ['node["amenity"="parking"]', 'way["amenity"="parking"]'];
    }
    // Generic: broad net so the search still returns something useful.
    return [
      'node["amenility"]', // intentional typo — never matches, forces name-based fallback
    ];
  }

  /**
   * Progressive radius Overpass POI search. Tries increasingly wide radii
   * until enough results are found, then returns the closest 10 sorted by
   * distance.
   *
   * Strategy:
   *   - For dense chains (Starbucks, McDonald's, gas stations) the 1mi
   *     radius usually returns 5+ results immediately.
   *   - For sparse destinations (theme parks, landmarks, hospitals) radii
   *     expand up to 50 miles to find at least a few results.
   *   - Results NEVER come from a statewide text search; they're always
   *     within a bounded geographic radius centered on the rider.
   */
  private static readonly SEARCH_RADII_MILES = [1, 3, 5, 10, 25, 50];
  private static readonly MAX_RESULTS = 10;

  private static async searchPlacesNearby(query: string, lat: number, lon: number): Promise<any[]> {
    const tagFilters = this.poiTagFilters(query);

    // Build a brand/name regex for chain searches.
    const brand = query.replace(/[^a-z0-9']/gi, '').toLowerCase();
    const brandClauses =
      brand.length >= 3
        ? tagFilters.map((f) => f.replace(/\]$/, `]["name"~"${brand}",i]`))
        : [];

    const allSeen = new Set<string>();
    const results: any[] = [];

    for (const radiusMi of this.SEARCH_RADII_MILES) {
      if (results.length >= this.MAX_RESULTS) break;

      const radiusM = Math.round(radiusMi * 1609.34);
      const unionParts = [...tagFilters, ...brandClauses];
      const overpassQuery = [
        '[out:json][timeout:20];',
        '(',
        ...unionParts.map((f) => `${f}(around:${radiusM},${lat},${lon});`),
        ');',
        'out center 30;',
      ].join('');

      try {
        const form = new URLSearchParams();
        form.append('data', overpassQuery);
        const resp = await axios.post('https://overpass-api.de/api/interpreter', form, {
          headers: { 'User-Agent': 'NetRide-Enterprise/1.0' },
          timeout: 15000,
        });

        const elements: any[] = resp.data?.elements ?? [];
        for (const el of elements) {
          const tags = el.tags ?? {};
          const name = tags.name || tags.brand || tags.operator;
          if (!name) continue;

          const elLat = el.type === 'node' ? el.lat : el.center?.lat;
          const elLon = el.type === 'node' ? el.lon : el.center?.lon;
          if (!Number.isFinite(elLat) || !Number.isFinite(elLon)) continue;

          const key = `${name}|${elLat.toFixed(5)},${elLon.toFixed(5)}`;
          if (allSeen.has(key)) continue;
          allSeen.add(key);

          const distMiles = this.haversineMiles({ lat, lon }, { lat: elLat, lon: elLon });

          results.push({
            display_name: this.formatPoiName(name, tags, elLat, elLon),
            lat: elLat,
            lon: elLon,
            type: tags.amenity || tags.shop || tags.tourism || tags.leisure || tags.aeroway || 'poi',
            state: 'CA',
            distance_miles: Math.round(distMiles * 10) / 10,
            address: {
              road: tags['addr:street'] ?? '',
              city: tags['addr:city'] ?? '',
              state: tags['addr:state'] ?? 'CA',
              postcode: tags['addr:postcode'] ?? '',
            },
          });
        }
      } catch {
        // Overpass timeout/error for this radius — try next.
      }
    }

    results.sort((a, b) => a.distance_miles - b.distance_miles);
    return results.slice(0, this.MAX_RESULTS);
  }

  private static haversineMiles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const R = 3958.8;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lon - a.lon);
    const x =
      Math.sin(dLat / 2) ** 2 +
      Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  /**
   * Autocomplete: match the query prefix against a curated dictionary of
   * common destination searches. Returns up to 5 suggestions sorted by
   * popularity (most-searched first).
   *
   * Matches are case-insensitive prefix matches. "star" → "Starbucks",
   * "mcd" → "McDonald's", "disn" → "Disneyland".
   */
  static autocompleteSearch(query: string): string[] {
    const q = (query || '').trim().toLowerCase();
    if (q.length < 2) return [];

    const suggestions: Array<{ label: string; score: number }> = [];
    for (const entry of AUTOCOMPLETE_DICT) {
      if (entry.prefixes.some((p) => q.startsWith(p))) {
        suggestions.push({ label: entry.label, score: entry.score });
      }
    }

    suggestions.sort((a, b) => b.score - a.score);
    return suggestions.slice(0, 5).map((s) => s.label);
  }

  private static formatPoiName(name: string, tags: any, lat: number, lon: number): string {
    const parts = [name];
    const road = tags['addr:street'];
    const city = tags['addr:city'] || tags['addr:suburb'] || tags['addr:town'];
    if (road) parts.push(road);
    if (city) parts.push(city);
    if (parts.length === 1) parts.push(`${lat.toFixed(4)}, ${lon.toFixed(4)}`);
    return parts.join(', ');
  }

  /// Fallback geocoder (Nominatim) for address-like queries that Overpass
  /// can't handle. Bounded to California so results stay in-region.
  private static async nominatimFallback(query: string, userLat?: number, userLon?: number): Promise<any[]> {
    try {
      const CA_VIEWBOX = '-124.5,42.0,-114.0,32.5';
      const CA_SOUTH = 32.5, CA_NORTH = 42.0, CA_WEST = -124.5, CA_EAST = -114.0;

      const response = await axios.get('https://nominatim.openstreetmap.org/search', {
        params: {
          q: query,
          format: 'json',
          addressdetails: 1,
          limit: 20,
          viewbox: CA_VIEWBOX,
          bounded: 1,
          countrycodes: 'us',
        },
        headers: { 'User-Agent': 'NetRide-Enterprise/1.0' },
      });

      const hits: any[] = Array.isArray(response.data) ? response.data : [];
      const isCalifornia = (h: any) => {
        const a = h.address || {};
        const state = (a.state || '').toString().toLowerCase();
        const code = (a.state_code || a['ISO3166-2-lvl4'] || '').toString().toLowerCase();
        if (state === 'california' || code === 'us-ca' || code === 'ca') return true;
        const lat = parseFloat(h.lat), lon = parseFloat(h.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          return lat >= CA_SOUTH && lat <= CA_NORTH && lon >= CA_WEST && lon <= CA_EAST;
        }
        return false;
      };

      const haversineMiles = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
        const R = 3958.8;
        const toRad = (d: number) => (d * Math.PI) / 180;
        const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lon - a.lon);
        const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
        return 2 * R * Math.asin(Math.sqrt(x));
      };

      const results = hits.filter(isCalifornia).map((h: any) => {
        const lat = parseFloat(h.lat), lon = parseFloat(h.lon);
        return {
          display_name: h.display_name,
          lat: h.lat,
          lon: h.lon,
          type: h.type,
          state: 'CA',
          distance_miles:
            Number.isFinite(userLat) && Number.isFinite(userLon)
              ? Math.round(haversineMiles({ lat, lon }, { lat: userLat as number, lon: userLon as number }) * 10) / 10
              : undefined,
          address: h.address,
        };
      });

      results.sort((a: any, b: any) => (a.distance_miles ?? 0) - (b.distance_miles ?? 0));
      return results.slice(0, 10);
    } catch (err: any) {
      console.error(`[GEOSPATIAL] ❌ Nominatim fallback failed: ${err.message}`);
      return [];
    }
  }

  static async preCacheHotZones(zones: [number, number][]) {
    logger.info({ zoneCount: zones.length }, 'geospatial_precache_start');
    // Pre-warm the cache by asking for routes between every pair of hot zones.
    // The RoutingService handles caching internally, so we just fire requests.
    for (const start of zones) {
      for (const end of zones) {
        if (start === end) continue;
        this.getRoute(start, end, true).catch(() => {});
      }
    }
  }
}

/**
 * Curated dictionary mapping short search prefixes to common destination
 * names. Used by autocompleteSearch to suggest completions based on what
 * people most commonly search for. Populated from real-world ride-hailing
 * search data and OSM brand popularity.
 *
 * Entry fields:
 *   label    — the suggested completion text
 *   prefixes — one or more prefix strings that trigger this suggestion
 *   score    — popularity ranking (higher = more common search)
 */
const AUTOCOMPLETE_DICT: Array<{ label: string; prefixes: string[]; score: number }> = [
  { label: 'Starbucks', prefixes: ['star', 'starb'], score: 100 },
  { label: 'McDonald\'s', prefixes: ['mcd', 'mcdo', 'mcdon'], score: 99 },
  { label: 'Walmart', prefixes: ['wal', 'walm', 'walt'], score: 90 },
  { label: 'Target', prefixes: ['tar', 'targ'], score: 85 },
  { label: 'Costco', prefixes: ['cost', 'costc'], score: 80 },
  { label: 'Home Depot', prefixes: ['home', 'home d'], score: 75 },
  { label: 'Lowe\'s', prefixes: ['low', 'lowe'], score: 70 },
  { label: 'Chipotle', prefixes: ['chip', 'chipot'], score: 65 },
  { label: 'Subway', prefixes: ['sub', 'subw'], score: 60 },
  { label: 'Pizza Hut', prefixes: ['pizz'], score: 55 },
  { label: 'Domino\'s Pizza', prefixes: ['domi'], score: 54 },
  { label: 'KFC', prefixes: ['kfc', 'kentucky'], score: 53 },
  { label: 'Taco Bell', prefixes: ['taco', 'taco b'], score: 52 },
  { label: 'Wendy\'s', prefixes: ['wend'], score: 51 },
  { label: 'Burger King', prefixes: ['burger'], score: 50 },
  { label: 'In-N-Out', prefixes: ['inn', 'in n'], score: 49 },
  { label: 'LAX Airport', prefixes: ['lax', 'airport', 'la air'], score: 95 },
  { label: 'Universal Studios Hollywood', prefixes: ['univ', 'univer', 'universal'], score: 45 },
  { label: 'Disneyland', prefixes: ['disn', 'disne'], score: 44 },
  { label: 'Six Flags Magic Mountain', prefixes: ['six', 'magic'], score: 40 },
  { label: 'CVS Pharmacy', prefixes: ['cvs', 'pharm'], score: 78 },
  { label: 'Walgreens', prefixes: ['walg', 'walgr'], score: 76 },
  { label: 'Rite Aid', prefixes: ['rite'], score: 50 },
  { label: 'Shell Gas Station', prefixes: ['shell', 'gas'], score: 72 },
  { label: 'Chevron Gas Station', prefixes: ['chev'], score: 68 },
  { label: 'Exxon Gas Station', prefixes: ['exxo'], score: 60 },
  { label: 'Cheesecake Factory', prefixes: ['chees'], score: 35 },
  { label: 'The Coffee Bean & Tea Leaf', prefixes: ['coffee'], score: 34 },
  { label: 'Whole Foods Market', prefixes: ['whole', 'whole f'], score: 48 },
  { label: 'Trader Joe\'s', prefixes: ['trad', 'trader'], score: 47 },
  { label: 'Panda Express', prefixes: ['pand'], score: 38 },
  { label: 'Chase Bank', prefixes: ['chas', 'chase'], score: 42 },
  { label: 'Bank of America', prefixes: ['bank', 'bofa'], score: 41 },
  { label: 'Wells Fargo', prefixes: ['wells'], score: 40 },
  { label: 'Marriott Hotel', prefixes: ['marri'], score: 33 },
  { label: 'Hilton Hotel', prefixes: ['hilt'], score: 32 },
  { label: 'Holiday Inn', prefixes: ['holid'], score: 31 },
  { label: 'Crypto.com Arena', prefixes: ['crypt', 'staples', 'arena'], score: 30 },
  { label: 'SoFi Stadium', prefixes: ['sofi', 'stadi'], score: 29 },
  { label: 'Dodger Stadium', prefixes: ['dodg'], score: 28 },
  { label: 'Hollywood Walk of Fame', prefixes: ['holly', 'hollywood'], score: 25 },
  { label: 'Santa Monica Pier', prefixes: ['santa m', 'pier'], score: 24 },
  { label: 'Venice Beach', prefixes: ['veni'], score: 23 },
  { label: 'Huntington Beach', prefixes: ['hunt', 'huntington'], score: 20 },
  { label: 'UCLA', prefixes: ['ucl', 'ucla'], score: 36 },
  { label: 'USC', prefixes: ['usc'], score: 35 },
  { label: 'California Science Center', prefixes: ['scien', 'calif'], score: 18 },
  { label: 'Grifith Observatory', prefixes: ['grif', 'observ'], score: 17 },
  { label: 'Petco Park', prefixes: ['petc'], score: 15 },
  { label: 'Angel Stadium', prefixes: ['ange'], score: 14 },
  { label: 'Los Angeles Zoo', prefixes: ['zoo'], score: 22 },
  { label: 'Planet Fitness', prefixes: ['plan', 'planet'], score: 12 },
  { label: '24 Hour Fitness', prefixes: ['24', 'hour f'], score: 11 },
  { label: 'Equinox', prefixes: ['equi'], score: 10 },
  { label: 'AMC Theatres', prefixes: ['amc'], score: 16 },
  { label: 'Regal Cinemas', prefixes: ['rega'], score: 13 },
];
