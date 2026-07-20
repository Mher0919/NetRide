"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeospatialService = void 0;
const axios_1 = __importDefault(require("axios"));
const http_1 = __importDefault(require("http"));
const p_throttle_1 = __importDefault(require("p-throttle"));
const env_1 = require("../../config/env");
const redis_1 = require("../../config/redis");
const ml_eta_service_1 = require("../../services/ml-eta.service");
const road_classifier_1 = require("../../utils/road-classifier");
const local_osrm_engine_1 = require("../routing/local-osrm.engine");
class GeospatialService {
    static async getRoute(start, end, isPreCache = false) {
        const cacheKey = this.generateCacheKey(start, end);
        // 1. L1 - CACHE LAYER
        const cached = await redis_1.redis.get(cacheKey);
        if (cached) {
            const result = JSON.parse(cached);
            result.cache_hit = true;
            return result;
        }
        if (this.inFlightRequests.has(cacheKey)) {
            return this.inFlightRequests.get(cacheKey);
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
        }
        finally {
            this.inFlightRequests.delete(cacheKey);
        }
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
            const resp = await axios_1.default.get('https://nominatim.openstreetmap.org/search', {
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
                    const resp = await axios_1.default.post('https://overpass-api.de/api/interpreter', formParams, {
                        headers: { 'User-Agent': 'NetRide-Enterprise/1.0' },
                        timeout: 25000,
                    });
                    return resp.data?.elements ?? [];
                }
                catch (postErr) {
                    console.warn(`[GEOSPATIAL] Overpass POST failed (${postErr.message}), trying GET...`);
                    // Fallback to GET
                    const resp = await axios_1.default.get('https://overpass-api.de/api/interpreter', {
                        params: { data: overpassQuery },
                        headers: { 'User-Agent': 'NetRide-Enterprise/1.0' },
                        timeout: 25000,
                    });
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
    static async searchPlaces(query, userLat, userLon) {
        const q = (query || '').trim();
        if (!q)
            return [];
        // When we have the rider's location, do a true nearby POI search.
        if (Number.isFinite(userLat) && Number.isFinite(userLon)) {
            const results = await this.searchPlacesNearby(q, userLat, userLon);
            if (results.length > 0)
                return results;
            // Fall through to Nominatim only if Overpass found nothing.
        }
        return this.searchPlacesNominatim(q, userLat, userLon);
    }
    /// Map a free-text query to OSM amenity/shop tags for the Overpass search.
    static poiTagFilters(query) {
        const ql = query.toLowerCase();
        const has = (...terms) => terms.some((t) => ql.includes(t));
        // Brand / chain name matches still resolve to an amenity via `name~`.
        if (has('coffee', 'cafe', 'espresso', 'starbucks', 'peet', 'blue bottle')) {
            return ['node["amenity"="cafe"]', 'way["amenity"="cafe"]', 'node["amenity"="coffee_shop"]', 'way["amenity"="coffee_shop"]'];
        }
        if (has('restaurant', 'dining', 'dinner', 'lunch')) {
            return ['node["amenity"="restaurant"]', 'way["amenity"="restaurant"]'];
        }
        if (has('fast', 'mcdonald', 'burger', 'kfc', 'wendy', 'taco', 'chipotle', 'subway', 'pizza', 'food')) {
            return ['node["amenity"="fast_food"]', 'way["amenity"="fast_food"]'];
        }
        if (has('bar', 'pub', 'nightclub', 'cocktail', 'beer')) {
            return ['node["amenity"="bar"]', 'way["amenity"="bar"]', 'node["amenity"="pub"]', 'way["amenity"="pub"]'];
        }
        if (has('gas', 'fuel', 'shell', 'chevron', 'arco', '76', 'exxon')) {
            return ['node["amenity"="fuel"]', 'way["amenity"="fuel"]'];
        }
        if (has('hotel', 'motel', 'inn', 'lodging', 'airbnb')) {
            return ['node["tourism"="hotel"]', 'way["tourism"="hotel"]', 'node["tourism"="motel"]', 'way["tourism"="motel"]'];
        }
        if (has('grocery', 'market', 'supermarket', 'whole foods', 'trader', 'target', 'walmart', 'store', 'shop')) {
            return ['node["shop"="supermarket"]', 'way["shop"="supermarket"]', 'node["shop"="convenience"]', 'way["shop"="convenience"]'];
        }
        if (has('park', 'playground', 'garden')) {
            return ['node["leisure"="park"]', 'way["leisure"="park"]'];
        }
        if (has('hospital', 'clinic', 'urgent', 'medical', 'doctor', 'pharmacy', 'cvs', 'walgreens')) {
            return ['node["amenity"="hospital"]', 'way["amenity"="hospital"]', 'node["amenity"="pharmacy"]', 'way["amenity"="pharmacy"]'];
        }
        if (has('school', 'university', 'college', 'campus')) {
            return ['node["amenity"="school"]', 'way["amenity"="school"]', 'node["amenity"="university"]', 'way["amenity"="university"]'];
        }
        if (has('bank', 'atm', 'chase', 'wells', 'bofa', 'citi')) {
            return ['node["amenity"="bank"]', 'way["amenity"="bank"]', 'node["amenity"="atm"]', 'way["amenity"="atm"]'];
        }
        // Generic: broad net so the search still returns something useful.
        return [
            'node["amenity"~"cafe|restaurant|fast_food|bar|pub|fuel|bank|pharmacy"]',
            'way["amenity"~"cafe|restaurant|fast_food|bar|pub|fuel|bank|pharmacy"]',
            'node["shop"]',
            'way["shop"]',
        ];
    }
    static async searchPlacesNearby(query, lat, lon) {
        // Search radius in meters. 1500m (≈1mi) captures the nearest options
        // first; if too few, the caller's Overpass query can be widened here.
        const radiusM = 2000;
        const tagFilters = this.poiTagFilters(query);
        // Build a brand/name regex for chain searches (Starbucks, McDonald's…).
        const brand = query.replace(/[^a-z0-9]/gi, '').toLowerCase();
        const brandClauses = brand.length >= 3
            ? tagFilters.map((f) => f.replace(/\]$/, `]["name"~"${brand}",i]`))
            : [];
        const unionParts = [...tagFilters, ...brandClauses];
        const overpassQuery = [
            '[out:json][timeout:25];',
            '(',
            ...unionParts.map((f) => `${f}(around:${radiusM},${lat},${lon});`),
            ');',
            'out center 30;',
        ].join('');
        const haversineMiles = (a, b) => {
            const R = 3958.8;
            const toRad = (d) => (d * Math.PI) / 180;
            const dLat = toRad(b.lat - a.lat);
            const dLng = toRad(b.lon - a.lon);
            const x = Math.sin(dLat / 2) ** 2 +
                Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
            return 2 * R * Math.asin(Math.sqrt(x));
        };
        try {
            const form = new URLSearchParams();
            form.append('data', overpassQuery);
            const resp = await axios_1.default.post('https://overpass-api.de/api/interpreter', form, {
                headers: { 'User-Agent': 'NetRide-Enterprise/1.0' },
                timeout: 25000,
            });
            const elements = resp.data?.elements ?? [];
            const seen = new Set();
            const results = [];
            for (const el of elements) {
                const tags = el.tags ?? {};
                const name = tags.name || tags.brand || tags.operator;
                if (!name)
                    continue;
                const elLat = el.type === 'node' ? el.lat : el.center?.lat;
                const elLon = el.type === 'node' ? el.lon : el.center?.lon;
                if (!Number.isFinite(elLat) || !Number.isFinite(elLon))
                    continue;
                const key = `${name}|${elLat.toFixed(5)},${elLon.toFixed(5)}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                const distMiles = haversineMiles({ lat, lon }, { lat: elLat, lon: elLon });
                results.push({
                    display_name: this.formatPoiName(name, tags, elLat, elLon),
                    lat: elLat,
                    lon: elLon,
                    type: tags.amenity || tags.shop || tags.tourism || 'poi',
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
            results.sort((a, b) => a.distance_miles - b.distance_miles);
            return results.slice(0, 15);
        }
        catch (err) {
            console.warn(`[GEOSPATIAL] Overpass POI search failed: ${err.message}`);
            return [];
        }
    }
    static formatPoiName(name, tags, lat, lon) {
        const parts = [name];
        const road = tags['addr:street'];
        const city = tags['addr:city'] || tags['addr:suburb'] || tags['addr:town'];
        if (road)
            parts.push(road);
        if (city)
            parts.push(city);
        if (parts.length === 1)
            parts.push(`${lat.toFixed(4)}, ${lon.toFixed(4)}`);
        return parts.join(', ');
    }
    /// Fallback geocoder (Nominatim) for address-like queries without a rider
    /// location. Bounded to California so results stay in-region.
    static async searchPlacesNominatim(query, userLat, userLon) {
        try {
            const CA_VIEWBOX = '-124.5,42.0,-114.0,32.5';
            const CA_SOUTH = 32.5, CA_NORTH = 42.0, CA_WEST = -124.5, CA_EAST = -114.0;
            const response = await this.axiosClient.get('https://nominatim.openstreetmap.org/search', {
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
            const hits = Array.isArray(response.data) ? response.data : [];
            const isCalifornia = (h) => {
                const a = h.address || {};
                const state = (a.state || '').toString().toLowerCase();
                const code = (a.state_code || a['ISO3166-2-lvl4'] || '').toString().toLowerCase();
                if (state === 'california' || code === 'us-ca' || code === 'ca')
                    return true;
                const lat = parseFloat(h.lat), lon = parseFloat(h.lon);
                if (Number.isFinite(lat) && Number.isFinite(lon)) {
                    return lat >= CA_SOUTH && lat <= CA_NORTH && lon >= CA_WEST && lon <= CA_EAST;
                }
                return false;
            };
            const haversineMiles = (a, b) => {
                const R = 3958.8;
                const toRad = (d) => (d * Math.PI) / 180;
                const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lon - a.lon);
                const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
                return 2 * R * Math.asin(Math.sqrt(x));
            };
            const results = hits.filter(isCalifornia).map((h) => {
                const lat = parseFloat(h.lat), lon = parseFloat(h.lon);
                return {
                    display_name: h.display_name,
                    lat: h.lat,
                    lon: h.lon,
                    type: h.type,
                    state: 'CA',
                    distance_miles: Number.isFinite(userLat) && Number.isFinite(userLon)
                        ? Math.round(haversineMiles({ lat, lon }, { lat: userLat, lon: userLon }) * 10) / 10
                        : undefined,
                    address: h.address,
                };
            });
            results.sort((a, b) => (a.distance_miles ?? 0) - (b.distance_miles ?? 0));
            return results.slice(0, 10);
        }
        catch (err) {
            console.error(`[GEOSPATIAL] ❌ Nominatim fallback failed: ${err.message}`);
            return [];
        }
    }
    static async fetchAndProcessRoute(start, end, cacheKey, retries = 0) {
        // Try the embedded in-process OSRM first (primary, Google-level, free).
        try {
            const res = await local_osrm_engine_1.LocalOsrmEngine.route(start, end);
            if (res) {
                this.isOsrmOnline = true;
                const multiplier = ml_eta_service_1.MLEtaService.predictMultiplier(start[0], start[1], res.distanceMeters);
                const result = {
                    distance: res.distanceMeters,
                    osrm_duration: res.durationSeconds,
                    eta: Math.round(res.durationSeconds * multiplier),
                    geometry: res.geometry,
                    steps: res.steps,
                    speedLimitsByRoad: res.speedLimitsByRoad,
                    cache_hit: false,
                    model_multiplier: multiplier,
                    engine: 'OSRM',
                };
                await redis_1.redis.set(cacheKey, JSON.stringify(result), 'EX', 600).catch(() => { });
                return result;
            }
        }
        catch (err) {
            console.error(`[GEOSPATIAL] ❌ Embedded OSRM failed: ${err.message}`);
        }
        // Secondary: remote OSRM_URL if configured.
        if (env_1.env.OSRM_URL) {
            try {
                const result = await this.fetchOsrmRoute(start, end, cacheKey);
                if (result)
                    return result;
            }
            catch (err) {
                if (this.isOsrmOnline) {
                    console.error(`[GEOSPATIAL] ❌ Router connection lost: ${err.message}`);
                    this.isOsrmOnline = false;
                }
            }
        }
        return this.calculateSyntheticRoute(start, end);
    }
    static async fetchOsrmRoute(start, end, cacheKey) {
        const url = `${env_1.env.OSRM_URL}/${start[1]},${start[0]};${end[1]},${end[0]}?overview=full&geometries=geojson&steps=true&annotations=true`;
        const response = await this.throttledGet(url);
        if (response.status !== 200 || !response.data.routes?.length)
            return null;
        this.isOsrmOnline = true;
        const route = response.data.routes[0];
        const multiplier = ml_eta_service_1.MLEtaService.predictMultiplier(start[0], start[1], route.distance);
        const rawSteps = route.legs?.[0]?.steps ?? [];
        const enrichedSteps = (0, road_classifier_1.enrichSteps)(rawSteps);
        const speedLimitsByRoad = this.buildSpeedMap(enrichedSteps);
        const result = {
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
        await redis_1.redis.set(cacheKey, JSON.stringify(result), 'EX', 600);
        return result;
    }
    static buildSpeedMap(steps) {
        const map = {};
        for (const step of steps) {
            const limit = step.speedLimitMph;
            if (!limit)
                continue;
            const keys = [step.name, step.ref].filter(k => typeof k === 'string' && k.length > 0);
            for (const k of keys)
                map[k] = limit;
        }
        return map;
    }
    static generateCacheKey(start, end) {
        const p = 4;
        return `route:${start[0].toFixed(p)}:${start[1].toFixed(p)}:${end[0].toFixed(p)}:${end[1].toFixed(p)}:driving`;
    }
    static calculateSyntheticRoute(start, end) {
        const speed = 6.1;
        const detour = 1.35;
        const lat1 = start[0], lon1 = start[1];
        const lat2 = end[0], lon2 = end[1];
        const R = 6371e3;
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δφ = (lat2 - lat1) * Math.PI / 180;
        const Δλ = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = R * c * detour;
        const duration = distance / speed;
        // Road-shaped (Manhattan/grid) polyline — never a single straight line.
        const midLat = (lat1 + lat2) / 2;
        const midLng = (lon1 + lon2) / 2;
        const qLat = lat1 + (lat2 - lat1) * 0.25;
        const qLng = lon1 + (lon2 - lon1) * 0.25;
        const tLat = lat1 + (lat2 - lat1) * 0.75;
        const tLng = lon1 + (lon2 - lon1) * 0.75;
        const coordinates = [
            [lon1, lat1],
            [qLng, lat1],
            [qLng, midLat],
            [midLng, midLat],
            [midLng, tLat],
            [tLng, tLat],
            [tLng, lat2],
            [lon2, lat2],
        ];
        return {
            distance,
            osrm_duration: duration,
            eta: Math.round(duration * 1.2),
            geometry: { type: 'LineString', coordinates },
            steps: [],
            speedLimitsByRoad: {},
            cache_hit: false,
            model_multiplier: 1.2,
            engine: 'Synthetic-Fallback'
        };
    }
    static async preCacheHotZones(zones) {
        console.log('[GEOSPATIAL] Router health check started in background...');
        let checks = 0;
        const maxChecks = 12;
        const checkInterval = setInterval(async () => {
            checks++;
            try {
                if (env_1.env.GEOAPIFY_API_KEY) {
                    await this.axiosClient.get(`https://api.geoapify.com/v1/routing?waypoints=${zones[0][0]},${zones[0][1]}|${zones[0][0] + 0.01},${zones[0][1] + 0.01}&mode=drive&apiKey=${env_1.env.GEOAPIFY_API_KEY}`, { timeout: 2000 });
                }
                else {
                    const url = `${env_1.env.OSRM_URL.replace('/route/v1/driving', '/nearest/v1/driving')}/${zones[0][1]},${zones[0][0]}?number=1`;
                    await this.axiosClient.get(url);
                }
                console.log('[GEOSPATIAL] 🟢 Router is ready. Triggering LA pre-cache...');
                this.isOsrmOnline = true;
                clearInterval(checkInterval);
                for (const start of zones) {
                    for (const end of zones) {
                        if (start === end)
                            continue;
                        this.getRoute(start, end, true).catch(() => { });
                    }
                }
            }
            catch (e) {
                if (checks >= maxChecks) {
                    console.log('[GEOSPATIAL] ℹ️ Router still offline. Continuing with synthetic fallback. Pre-caching disabled.');
                    clearInterval(checkInterval);
                }
            }
        }, 5000);
    }
}
exports.GeospatialService = GeospatialService;
_a = GeospatialService;
GeospatialService.inFlightRequests = new Map();
GeospatialService.isOsrmOnline = false; // Readiness Guard
GeospatialService.throttler = (0, p_throttle_1.default)({ limit: 50, interval: 1000 });
GeospatialService.axiosClient = axios_1.default.create({
    httpAgent: new http_1.default.Agent({ keepAlive: true, maxSockets: 100 }),
    timeout: 2000,
});
GeospatialService.throttledGet = _a.throttler(async (url) => {
    return _a.axiosClient.get(url);
});
// ---- Inspection-location helpers (driver app) --------------------------
/// CA bounding constants used for validating geocoded ZIPs.
GeospatialService.CA_BBOX = {
    south: 32.5,
    north: 42.0,
    west: -124.5,
    east: -114.0,
};
//# sourceMappingURL=geospatial.service.js.map