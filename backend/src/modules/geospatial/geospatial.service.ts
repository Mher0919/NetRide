import axios from 'axios';
import { redis } from '../../config/redis';
import { env } from '../../config/env';
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

  // ---- Places search & autocomplete (Geoapify API) -----------------------
  //
  // Geoapify provides a free tier (3,000 req/day) with both a Places API for
  // nearby POI search and a Geocoding Autocomplete API for search suggestions.
  // This replaces the earlier Overpass solution which was unreliable due to
  // rate limits and timeouts on the community-run free tier.

  private static readonly GEOAPIFY_BASE = 'https://api.geoapify.com';
  private static readonly SEARCH_RADII_MILES = [1, 3, 5, 10, 25, 50];
  private static readonly MAX_PLACES = 10;

  /** Map common free-text queries to Geoapify category filters. */
  private static geoapifyCategory(query: string): string[] {
    const ql = query.toLowerCase();
    const has = (...terms: string[]) => terms.some((t) => ql.includes(t));
    if (has('coffee', 'cafe', 'espresso', 'starbucks', 'peet', 'starb'))
      return ['catering.cafe', 'catering.coffee_shop'];
    if (has('restaurant', 'dining', 'dinner', 'lunch', 'breakfast', 'brunch'))
      return ['catering.restaurant'];
    if (has('fast', 'mcdonald', 'burger', 'kfc', 'wendy', 'taco', 'chipotle', 'subway', 'pizza', 'food'))
      return ['catering.fast_food'];
    if (has('bar', 'pub', 'nightclub', 'cocktail', 'beer', 'lounge'))
      return ['catering.bar', 'catering.pub'];
    if (has('gas', 'fuel', 'shell', 'chevron', 'arco', 'exxon', 'charging'))
      return ['service.vehicle.fuel'];
    if (has('hotel', 'motel', 'inn', 'lodging', 'airbnb', 'hostel'))
      return ['accommodation.hotel'];
    if (has('grocery', 'market', 'supermarket', 'whole foods', 'trader', 'costco'))
      return ['commercial.supermarket'];
    if (has('target', 'walmart', 'store', 'shop', 'mall'))
      return ['commercial'];
    if (has('park', 'playground', 'garden', 'zoo'))
      return ['leisure.park'];
    if (has('hospital', 'clinic', 'urgent', 'medical', 'doctor'))
      return ['healthcare'];
    if (has('pharmacy', 'drug', 'cvs', 'walgreen', 'rite aid'))
      return ['healthcare.pharmacy'];
    if (has('school', 'university', 'college', 'campus'))
      return ['education'];
    if (has('bank', 'atm', 'chase', 'wells', 'bofa', 'citi'))
      return ['service.financial'];
    if (has('airport', 'lax', 'burbank', 'sfo', 'oakland'))
      return ['transport.airport'];
    if (has('disney', 'disn', 'theme park', 'amusement'))
      return ['leisure.theme_park'];
    if (has('gym', 'fitness', 'workout', 'la fitness', 'planet fitness', 'equinox'))
      return ['sport.fitness_centre'];
    if (has('stadium', 'arena', 'concert', 'venue', 'sofi', 'dodger'))
      return ['leisure.stadium', 'leisure.sports_hall'];
    if (has('movie', 'cinema', 'theater', 'amc', 'regal'))
      return ['entertainment.cinema'];
    if (has('post', 'mail', 'fedex', 'ups'))
      return ['service.post_office'];
    return [];
  }

  /**
   * Search for places near the user or get autocomplete suggestions.
   *
   * With lat/lon: uses Geoapify Places API (progressive radius 1–50mi).
   * Without lat/lon: uses Geoapify Autocomplete API.
   * Falls back to static suggestions if Geoapify is unreachable.
   */
  static async searchPlaces(query: string, userLat?: number, userLon?: number): Promise<any[]> {
    const q = (query || '').trim();
    if (!q) return [];

    // Check Redis cache first
    const cacheKey = `search:${q.toLowerCase()}:${userLat?.toFixed(2) ?? '0'}:${userLon?.toFixed(2) ?? '0'}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {
      // cache miss or redis down — proceed
    }

    let results: any[] = [];

    if (!env.GEOAPIFY_API_KEY) {
      logger.warn('geospatial_no_geoapify_key');
      results = await this.autocompleteSearch(q, userLat, userLon);
      this.cacheSearchResults(cacheKey, results);
      return results;
    }

    const apiKey = env.GEOAPIFY_API_KEY;

    if (Number.isFinite(userLat) && Number.isFinite(userLon)) {
      const lat = userLat as number;
      const lon = userLon as number;
      const categories = this.geoapifyCategory(q);

      for (const radiusMi of this.SEARCH_RADII_MILES) {
        const radiusM = Math.round(radiusMi * 1609.34);
        try {
          const params: Record<string, string> = {
            apiKey,
            filter: `circle:${lon},${lat},${radiusM}`,
            limit: String(this.MAX_PLACES),
            lang: 'en',
          };
          if (categories.length > 0) {
            params.categories = categories.join(',');
          } else {
            params.text = q;
          }

          const resp = await axios.get(`${this.GEOAPIFY_BASE}/v2/places`, {
            params,
            timeout: 8000,
          });

          const features: any[] = resp.data?.features ?? [];
          if (features.length === 0) continue;

          results = features.map((f: any) => {
            const props = f.properties || {};
            const coords = f.geometry?.coordinates || [0, 0];
            const distMiles = this.haversineMiles(
              { lat, lon },
              { lat: coords[1], lon: coords[0] },
            );

            return {
              display_name: this.formatGeoapifyName(props),
              lat: coords[1],
              lon: coords[0],
              type: props.categories?.[0] || props.result_type || 'poi',
              state: props.state || 'CA',
              distance_miles: Math.round(distMiles * 10) / 10,
              address: {
                road: props.street || '',
                city: props.city || '',
                state: props.state || 'CA',
                postcode: props.postcode || '',
              },
            };
          }).slice(0, this.MAX_PLACES);

          this.cacheSearchResults(cacheKey, results);
          return results;
        } catch {
          // Try next radius
        }
      }

      results = await this.autocompleteSearch(q, userLat, userLon);
      this.cacheSearchResults(cacheKey, results);
      return results;
    }

    results = await this.autocompleteSearch(q, userLat, userLon);
    this.cacheSearchResults(cacheKey, results);
    return results;
  }

  private static async cacheSearchResults(cacheKey: string, results: any[]): Promise<void> {
    if (results.length === 0) return;
    try {
      await redis.set(cacheKey, JSON.stringify(results), 'EX', 300).catch(() => {});
    } catch {
      // cache write failure is non-critical
    }
  }

  /**
   * Autocomplete using Geoapify Geocoding Autocomplete API.
   * Uses location bias when user lat/lon is provided.
   * Falls back to static suggestions if Geoapify is unavailable.
   */
  static async autocompleteSearch(query: string, userLat?: number, userLon?: number): Promise<any[]> {
    const q = (query || '').trim();
    if (q.length < 2) return [];

    if (env.GEOAPIFY_API_KEY) {
      try {
        const params: Record<string, any> = {
          text: q,
          apiKey: env.GEOAPIFY_API_KEY,
          limit: 8,
          lang: 'en',
          type: 'amenity',
        };

        if (Number.isFinite(userLat) && Number.isFinite(userLon)) {
          params.bias = `proximity:${userLon},${userLat}`;
          params.filter = `countrycode:us`;
        } else {
          params.filter = `countrycode:us`;
        }

        const resp = await axios.get(`${this.GEOAPIFY_BASE}/v1/geocode/autocomplete`, {
          params,
          timeout: 5000,
        });

        const features: any[] = resp.data?.features ?? [];
        if (features.length > 0) {
          return features.map((f: any) => {
            const props = f.properties || {};
            const coords = f.geometry?.coordinates || [0, 0];
            const distMiles = Number.isFinite(userLat) && Number.isFinite(userLon)
              ? this.haversineMiles(
                  { lat: userLat as number, lon: userLon as number },
                  { lat: coords[1], lon: coords[0] },
                )
              : undefined;

            return {
              display_name: props.formatted || props.name || props.address_line1 || q,
              lat: coords[1],
              lon: coords[0],
              type: props.result_type || 'suggestion',
              state: props.state || '',
              distance_miles: distMiles !== undefined ? Math.round(distMiles * 10) / 10 : undefined,
              is_suggestion: true,
              place_id: props.place_id,
            };
          });
        }
      } catch {
        // Fall through to static suggestions
      }
    }

    // Static suggestion fallback with location-aware results
    const suggestions = STATIC_SUGGESTIONS
      .filter((s) => s.prefixes.some((p) => q.toLowerCase().startsWith(p)))
      .slice(0, 6)
      .map((s) => ({
        display_name: s.label,
        lat: 0, lon: 0,
        type: 'suggestion',
        state: '',
        distance_miles: undefined,
        is_suggestion: true,
      }));

    return suggestions;
  }

  private static formatGeoapifyName(props: any): string {
    const name = props.name || props.address_line1 || '';
    const street = props.street || '';
    const city = props.city || '';
    const parts = [name];
    if (street && !name.includes(street)) parts.push(street);
    if (city && !name.includes(city)) parts.push(city);
    return parts.join(', ');
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
const STATIC_SUGGESTIONS: Array<{ label: string; prefixes: string[]; score: number }> = [
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
