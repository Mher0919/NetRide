"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeospatialService = void 0;
const axios_1 = __importDefault(require("axios"));
const redis_1 = require("../../config/redis");
const env_1 = require("../../config/env");
const routing_service_1 = require("../routing/routing.service");
const logger_1 = require("../../observability/logger");
const circuit_breaker_1 = require("../../utils/circuit-breaker");
class GeospatialService {
    /**
     * All routing flows through the single RoutingService (which owns the
     * provider selection, cache, dedup, retries, and fallback). GeospatialService
     * is a thin adapter that maps the routing result into the legacy `RouteResponse`
     * shape the dispatch / navigation / controller layers expect.
     */
    static async getRoute(start, end, isPreCache = false) {
        const requestStartTime = Date.now();
        const route = await routing_service_1.RoutingService.calculateRoute([start[0], start[1]], [end[0], end[1]]);
        const multiplier = route.durationSeconds > 0
            ? route.etaSeconds / route.durationSeconds
            : 1.2;
        if (!isPreCache) {
            const totalLatency = Date.now() - requestStartTime;
            logger_1.logger.info({ latencyMs: totalLatency, engine: route.engine, cacheHit: route.cacheHit }, 'geospatial_route');
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
    static isInCalifornia(lat, lon) {
        return (lat >= this.CA_BBOX.south &&
            lat <= this.CA_BBOX.north &&
            lon >= this.CA_BBOX.west &&
            lon <= this.CA_BBOX.east);
    }
    /// Geocode a ZIP code to {lat, lon} via Nominatim (nationwide).
    /// Returns null if the ZIP can't be resolved or lies outside CA.
    static async geocodeZip(zip) {
        const cacheKey = `geocode:zip:${zip}`;
        try {
            const cached = await redis_1.redis.get(cacheKey);
            if (cached) {
                const parsed = JSON.parse(cached);
                return { lat: parsed.lat, lon: parsed.lon };
            }
        }
        catch {
            // cache miss or redis down — proceed
        }
        try {
            const resp = await circuit_breaker_1.nominatimBreaker.execute(() => axios_1.default.get('https://nominatim.openstreetmap.org/search', {
                params: {
                    q: zip,
                    format: 'json',
                    countrycodes: 'us',
                    limit: 1,
                },
                headers: { 'User-Agent': 'NetRide-Enterprise/1.0' },
                timeout: 5000,
            }));
            const data = resp.data;
            if (!Array.isArray(data) || data.length === 0)
                return null;
            const lat = parseFloat(data[0].lat);
            const lon = parseFloat(data[0].lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon))
                return null;
            if (!this.isInCalifornia(lat, lon)) {
                console.log(`[GEOSPATIAL] ZIP ${zip} resolved to non-CA location (${lat},${lon}) — rejecting`);
                return null;
            }
            const result = { lat, lon };
            // Cache for 24 hours
            await redis_1.redis.set(cacheKey, JSON.stringify(result), 'EX', 86400).catch(() => { });
            return result;
        }
        catch (err) {
            console.error(`[GEOSPATIAL] ❌ Geocode failed for ZIP ${zip}: ${err.message}`);
            return null;
        }
    }
    /// Search for vehicle-inspection-related POIs near (lat,lon) using the
    /// Overpass API.  Progressively expands the search radius until we have
    /// enough results or hit the cap.
    static async findNearbyInspections(lat, lon) {
        const RADII_KM = [5, 10, 25, 50];
        const seen = new Set();
        const results = [];
        const haversine = (a, b) => {
            const R = 3958.8;
            const toRad = (d) => (d * Math.PI) / 180;
            const dLat = toRad(b.lat - a.lat);
            const dLng = toRad(b.lon - a.lon);
            const x = Math.sin(dLat / 2) ** 2 +
                Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
            return 2 * R * Math.asin(Math.sqrt(x));
        };
        for (const radiusKm of RADII_KM) {
            if (results.length >= 5)
                break;
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
            const fetchOverpass = async () => {
                // Try POST first (preferred for longer queries).
                try {
                    const formParams = new URLSearchParams();
                    formParams.append('data', overpassQuery);
                    const resp = await circuit_breaker_1.overpassBreaker.execute(() => axios_1.default.post('https://overpass-api.de/api/interpreter', formParams, {
                        headers: { 'User-Agent': 'NetRide-Enterprise/1.0' },
                        timeout: 25000,
                    }));
                    return resp.data?.elements ?? [];
                }
                catch (postErr) {
                    console.warn(`[GEOSPATIAL] Overpass POST failed (${postErr.message}), trying GET...`);
                    // Fallback to GET
                    const resp = await circuit_breaker_1.overpassBreaker.execute(() => axios_1.default.get('https://overpass-api.de/api/interpreter', {
                        params: { data: overpassQuery },
                        headers: { 'User-Agent': 'NetRide-Enterprise/1.0' },
                        timeout: 25000,
                    }));
                    return resp.data?.elements ?? [];
                }
            };
            try {
                const elements = await fetchOverpass();
                for (const el of elements) {
                    const tags = el.tags ?? {};
                    const name = tags.name;
                    if (!name)
                        continue;
                    const elLat = el.type === 'node' ? el.lat : el.center?.lat;
                    const elLon = el.type === 'node' ? el.lon : el.center?.lon;
                    if (!Number.isFinite(elLat) || !Number.isFinite(elLon))
                        continue;
                    const addrParts = [
                        tags['addr:housenumber'],
                        tags['addr:street'],
                        tags['addr:city'],
                        tags['addr:state'],
                        tags['addr:postcode'],
                    ].filter(Boolean);
                    const addrStr = addrParts.length > 0 ? addrParts.join(', ') : null;
                    const key = `${name}|${addrStr ?? elLat},${elLon}`;
                    if (seen.has(key))
                        continue;
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
            }
            catch (err) {
                console.error(`[GEOSPATIAL] ❌ Overpass query failed at ${radiusKm}km: ${err.message}`);
            }
        }
        results.sort((a, b) => (a.distance_miles ?? 999) - (b.distance_miles ?? 999));
        return results.slice(0, 15);
    }
    static get googleMapsApiKey() {
        return env_1.env.GOOGLE_ROUTES_API_KEY || env_1.env.GOOGLE_MAPS_API_KEY;
    }
    /** Google Places Text Search — returns nearby places with coordinates. */
    static async googlePlacesSearchText(query, userLat, userLon) {
        const apiKey = this.googleMapsApiKey;
        if (!apiKey)
            return [];
        try {
            const params = {
                query,
                key: apiKey,
                language: 'en',
            };
            if (Number.isFinite(userLat) && Number.isFinite(userLon)) {
                params.location = `${userLat},${userLon}`;
                params.radius = 50000;
            }
            const resp = await circuit_breaker_1.googlePlacesBreaker.execute(() => axios_1.default.get(`${this.GOOGLE_PLACES_BASE}/textsearch/json`, { params, timeout: 5000 }));
            const results = resp.data?.results ?? [];
            if (results.length === 0)
                return [];
            return results.slice(0, this.MAX_PLACES).map((r) => {
                const loc = r.geometry?.location || {};
                const lat = loc.lat ?? 0;
                const lng = loc.lng ?? 0;
                const addr = r.formatted_address || '';
                const shortAddr = addr.split(',')[0] || '';
                const displayName = r.name && shortAddr ? `${r.name}, ${shortAddr}` : (r.name || addr || query);
                const distMiles = Number.isFinite(userLat) && Number.isFinite(userLon) && lat
                    ? this.haversineMiles({ lat: userLat, lon: userLon }, { lat, lon: lng })
                    : undefined;
                return {
                    display_name: displayName,
                    lat,
                    lon: lng,
                    type: (r.types?.[0] || 'point_of_interest').replace(/_/g, ' ').toLowerCase(),
                    state: '',
                    distance_miles: distMiles !== undefined ? Math.round(distMiles * 10) / 10 : undefined,
                    address: {
                        road: addr.split(',')[0] || '',
                        city: addr.split(',')[1]?.trim() || '',
                        state: addr.split(',')[2]?.trim()?.split(' ')[0] || '',
                        postcode: '',
                    },
                    is_suggestion: false,
                    place_id: r.place_id,
                };
            });
        }
        catch {
            return [];
        }
    }
    /** Google Places Query Autocomplete — cheap call, no Place Details.
     *  Uses user's coordinates as approximate location for results.
     *  Place Details ($17/1000) is deferred until user selects a result. */
    static async googlePlacesAutocomplete(query, userLat, userLon) {
        const apiKey = this.googleMapsApiKey;
        if (!apiKey)
            return [];
        try {
            const params = {
                input: query,
                key: apiKey,
                language: 'en',
            };
            if (Number.isFinite(userLat) && Number.isFinite(userLon)) {
                params.location = `${userLat},${userLon}`;
                params.radius = 50000;
            }
            const resp = await circuit_breaker_1.googlePlacesBreaker.execute(() => axios_1.default.get(`${this.GOOGLE_PLACES_BASE}/queryautocomplete/json`, { params, timeout: 5000 }));
            const predictions = resp.data?.predictions ?? [];
            if (predictions.length === 0)
                return [];
            const lat = Number.isFinite(userLat) ? userLat : 0;
            const lon = Number.isFinite(userLon) ? userLon : 0;
            return predictions.slice(0, 5).map((p) => {
                const distMiles = lat
                    ? Math.round(this.haversineMiles({ lat, lon }, { lat, lon }) * 10) / 10
                    : undefined;
                return {
                    display_name: p.description || query,
                    lat, lon,
                    type: 'suggestion',
                    state: '',
                    distance_miles: distMiles,
                    is_suggestion: true,
                    place_id: p.place_id,
                };
            });
        }
        catch {
            return [];
        }
    }
    /** Map common free-text queries to Geoapify category filters. */
    static geoapifyCategory(query) {
        const ql = query.toLowerCase();
        const has = (...terms) => terms.some((t) => ql.includes(t));
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
     * Tries: Google Places Text Search → Geoapify Places API → Autocomplete fallback.
     */
    static async searchPlaces(query, userLat, userLon) {
        const q = (query || '').trim();
        if (!q)
            return [];
        const latKey = Number.isFinite(userLat) ? userLat.toFixed(1) : '0';
        const lonKey = Number.isFinite(userLon) ? userLon.toFixed(1) : '0';
        const cacheKey = `search:${q.toLowerCase()}:${latKey}:${lonKey}`;
        // Check Redis cache
        try {
            const cached = await redis_1.redis.get(cacheKey);
            if (cached)
                return JSON.parse(cached);
        }
        catch { /* cache miss */ }
        // Deduplicate in-flight requests
        const inFlight = this.inFlight.get(cacheKey);
        if (inFlight)
            return inFlight;
        const promise = this._searchPlaces(q, userLat, userLon, cacheKey);
        this.inFlight.set(cacheKey, promise);
        try {
            return await promise;
        }
        finally {
            this.inFlight.delete(cacheKey);
        }
    }
    static async _searchPlaces(q, userLat, userLon, cacheKey) {
        // 1. Google Places Text Search — expensive ($32/1000), skip for short queries
        if (this.googleMapsApiKey && q.length >= this.MIN_TEXT_SEARCH_LEN) {
            const googleResults = await this.googlePlacesSearchText(q, userLat, userLon);
            if (googleResults.length > 0) {
                if (cacheKey)
                    this.cacheSearchResults(cacheKey, googleResults, this.TEXT_SEARCH_CACHE_TTL_S);
                return googleResults;
            }
        }
        // 2. Geoapify Places API (progressive radii, free tier 3000/day)
        if (env_1.env.GEOAPIFY_API_KEY && Number.isFinite(userLat) && Number.isFinite(userLon)) {
            const lat = userLat;
            const lon = userLon;
            const categories = this.geoapifyCategory(q);
            for (const radiusMi of this.SEARCH_RADII_MILES) {
                const radiusM = Math.round(radiusMi * 1609.34);
                try {
                    const params = {
                        apiKey: env_1.env.GEOAPIFY_API_KEY,
                        filter: `circle:${lon},${lat},${radiusM}`,
                        limit: String(this.MAX_PLACES),
                        lang: 'en',
                        text: q,
                    };
                    if (categories.length > 0) {
                        params.categories = categories.join(',');
                    }
                    const resp = await circuit_breaker_1.geoapifyBreaker.execute(() => axios_1.default.get(`${this.GEOAPIFY_BASE}/v2/places`, { params, timeout: 8000 }));
                    const features = resp.data?.features ?? [];
                    if (features.length === 0)
                        continue;
                    const results = features.map((f) => {
                        const props = f.properties || {};
                        const coords = f.geometry?.coordinates || [0, 0];
                        const distMiles = this.haversineMiles({ lat, lon }, { lat: coords[1], lon: coords[0] });
                        return {
                            display_name: this.formatGeoapifyName(props),
                            lat: coords[1], lon: coords[0],
                            type: props.categories?.[0] || props.result_type || 'poi',
                            state: props.state || 'CA',
                            distance_miles: Math.round(distMiles * 10) / 10,
                            address: { road: props.street || '', city: props.city || '', state: props.state || 'CA', postcode: props.postcode || '' },
                        };
                    }).slice(0, this.MAX_PLACES);
                    if (cacheKey)
                        this.cacheSearchResults(cacheKey, results, this.SEARCH_CACHE_TTL_S);
                    return results;
                }
                catch { /* Try next radius */ }
            }
        }
        // 3. Autocomplete fallback (cheap Google Autocomplete → Geoapify → static suggestions)
        const results = await this.autocompleteSearch(q, userLat, userLon);
        if (cacheKey)
            this.cacheSearchResults(cacheKey, results, this.SEARCH_CACHE_TTL_S);
        return results;
    }
    static async cacheSearchResults(cacheKey, results, ttl = this.SEARCH_CACHE_TTL_S) {
        if (results.length === 0)
            return;
        try {
            await redis_1.redis.set(cacheKey, JSON.stringify(results), 'EX', ttl).catch(() => { });
        }
        catch { /* cache write failure is non-critical */ }
    }
    /**
     * Autocomplete using Google Places, then Geoapify, then static suggestions.
     */
    static async autocompleteSearch(query, userLat, userLon) {
        const q = (query || '').trim();
        if (q.length < this.MIN_AUTOCOMPLETE_LEN)
            return [];
        // 1. Google Places Autocomplete (returns real coordinates via Place Details)
        if (this.googleMapsApiKey) {
            const googleResults = await this.googlePlacesAutocomplete(q, userLat, userLon);
            if (googleResults.length > 0)
                return googleResults;
        }
        // 2. Geoapify Geocoding Autocomplete
        if (env_1.env.GEOAPIFY_API_KEY) {
            try {
                const params = {
                    text: q,
                    apiKey: env_1.env.GEOAPIFY_API_KEY,
                    limit: 8,
                    lang: 'en',
                    type: 'amenity',
                };
                if (Number.isFinite(userLat) && Number.isFinite(userLon)) {
                    params.bias = `proximity:${userLon},${userLat}`;
                    params.filter = `countrycode:us`;
                }
                else {
                    params.filter = `countrycode:us`;
                }
                const resp = await circuit_breaker_1.geoapifyBreaker.execute(() => axios_1.default.get(`${this.GEOAPIFY_BASE}/v1/geocode/autocomplete`, { params, timeout: 5000 }));
                const features = resp.data?.features ?? [];
                if (features.length > 0) {
                    return features.map((f) => {
                        const props = f.properties || {};
                        const coords = f.geometry?.coordinates || [0, 0];
                        const distMiles = Number.isFinite(userLat) && Number.isFinite(userLon)
                            ? this.haversineMiles({ lat: userLat, lon: userLon }, { lat: coords[1], lon: coords[0] })
                            : undefined;
                        return {
                            display_name: props.formatted || props.name || props.address_line1 || q,
                            lat: coords[1], lon: coords[0],
                            type: props.result_type || 'suggestion',
                            state: props.state || '',
                            distance_miles: distMiles !== undefined ? Math.round(distMiles * 10) / 10 : undefined,
                            is_suggestion: true,
                            place_id: props.place_id,
                        };
                    });
                }
            }
            catch { /* fall through */ }
        }
        // 3. Static suggestion fallback — use user's location so results appear nearby
        const fallbackLat = Number.isFinite(userLat) ? userLat : 0;
        const fallbackLon = Number.isFinite(userLon) ? userLon : 0;
        return STATIC_SUGGESTIONS
            .filter((s) => s.label.toLowerCase().startsWith(q.toLowerCase()) ||
            s.prefixes.some((p) => p.startsWith(q.toLowerCase())))
            .slice(0, 6)
            .map((s) => ({
            display_name: s.label,
            lat: fallbackLat, lon: fallbackLon,
            type: 'suggestion',
            state: '',
            distance_miles: undefined,
            is_suggestion: true,
        }));
    }
    static formatGeoapifyName(props) {
        const name = props.name || props.address_line1 || '';
        const street = props.street || '';
        const city = props.city || '';
        const parts = [name];
        if (street && !name.includes(street))
            parts.push(street);
        if (city && !name.includes(city))
            parts.push(city);
        return parts.join(', ');
    }
    static haversineMiles(a, b) {
        const R = 3958.8;
        const toRad = (d) => (d * Math.PI) / 180;
        const dLat = toRad(b.lat - a.lat);
        const dLng = toRad(b.lon - a.lon);
        const x = Math.sin(dLat / 2) ** 2 +
            Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
        return 2 * R * Math.asin(Math.sqrt(x));
    }
    static async preCacheHotZones(zones) {
        logger_1.logger.info({ zoneCount: zones.length }, 'geospatial_precache_start');
        // Pre-warm the cache by asking for routes between every pair of hot zones.
        // The RoutingService handles caching internally, so we just fire requests.
        for (const start of zones) {
            for (const end of zones) {
                if (start === end)
                    continue;
                this.getRoute(start, end, true).catch(() => { });
            }
        }
    }
}
exports.GeospatialService = GeospatialService;
// ---- Inspection-location helpers (driver app) --------------------------
/// CA bounding constants used for validating geocoded ZIPs.
GeospatialService.CA_BBOX = {
    south: 32.5,
    north: 42.0,
    west: -124.5,
    east: -114.0,
};
// ---- Places search & autocomplete (Google Places + Geoapify) -----------
//
// Primary: Google Places API (uses GOOGLE_MAPS_API_KEY / GOOGLE_ROUTES_API_KEY).
// Falls back to Geoapify, then static suggestions.
GeospatialService.GOOGLE_PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';
GeospatialService.GEOAPIFY_BASE = 'https://api.geoapify.com';
GeospatialService.SEARCH_RADII_MILES = [1, 3, 5, 10, 25, 50];
GeospatialService.MAX_PLACES = 10;
GeospatialService.SEARCH_CACHE_TTL_S = 600;
GeospatialService.TEXT_SEARCH_CACHE_TTL_S = 300;
GeospatialService.MIN_AUTOCOMPLETE_LEN = 2;
GeospatialService.MIN_TEXT_SEARCH_LEN = 4;
GeospatialService.inFlight = new Map();
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
const STATIC_SUGGESTIONS = [
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
//# sourceMappingURL=geospatial.service.js.map