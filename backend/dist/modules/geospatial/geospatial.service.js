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
    static async searchPlaces(query, userLat, userLon) {
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
            const params = {
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
            let hits = Array.isArray(response.data) ? response.data : [];
            // 1. Drop anything Nominatim resolved to a non-CA state. The
            // `addressdetails=1` query puts `state` / `state_code` on each hit.
            const isCalifornia = (h) => {
                const a = h.address || {};
                const state = (a.state || '').toString().toLowerCase();
                const code = (a.state_code || a['ISO3166-2-lvl4'] || '').toString().toLowerCase();
                if (state === 'california' || code === 'us-ca' || code === 'ca')
                    return true;
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
            const dedupeKey = (h) => {
                const a = h.address || {};
                const name = (h.display_name || '').split(',')[0].trim().toLowerCase();
                const city = (a.city || a.town || a.village || a.hamlet || a.suburb || '').toString().toLowerCase();
                return `${name}::${city}`;
            };
            const byKey = new Map();
            const haversineMiles = (a, b) => {
                const R = 3958.8;
                const toRad = (d) => (d * Math.PI) / 180;
                const dLat = toRad(b.lat - a.lat);
                const dLng = toRad(b.lon - a.lon);
                const x = Math.sin(dLat / 2) ** 2 +
                    Math.sin(dLng / 2) ** 2 *
                        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
                return 2 * R * Math.asin(Math.sqrt(x));
            };
            for (const hit of results) {
                const key = dedupeKey(hit);
                if (!key || key === '::')
                    continue;
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
                    r._dist_miles = haversineMiles({ lat: r._lat, lon: r._lon }, { lat: userLat, lon: userLon });
                }
                results.sort((a, b) => (a._dist_miles ?? 0) - (b._dist_miles ?? 0));
            }
            // 4. Slice to top 10 and tag with `state: 'CA'` so the rider UI
            // can render its "in California" badge.
            return results.slice(0, 10).map((item) => ({
                display_name: item.display_name,
                lat: item.lat,
                lon: item.lon,
                type: item.type,
                state: 'CA',
                distance_miles: userLat !== undefined && userLon !== undefined
                    ? Math.round((item._dist_miles ?? 0) * 10) / 10
                    : undefined,
                address: item.address,
            }));
        }
        catch (err) {
            console.error(`[GEOSPATIAL] ❌ Search failed: ${err.message}`);
            return [];
        }
    }
    static async fetchAndProcessRoute(start, end, cacheKey, retries = 0) {
        if (!this.isOsrmOnline && retries === 0) {
            return this.calculateSyntheticRoute(start, end);
        }
        try {
            if (env_1.env.GEOAPIFY_API_KEY) {
                const result = await this.fetchGeoapifyRoute(start, end, cacheKey);
                if (result)
                    return result;
            }
            else {
                const result = await this.fetchOsrmRoute(start, end, cacheKey);
                if (result)
                    return result;
            }
        }
        catch (err) {
            if (retries > 0) {
                await new Promise(resolve => setTimeout(resolve, 3000));
                return this.fetchAndProcessRoute(start, end, cacheKey, retries - 1);
            }
            if (this.isOsrmOnline) {
                console.error(`[GEOSPATIAL] ❌ Router connection lost: ${err.message}`);
                this.isOsrmOnline = false;
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
    static async fetchGeoapifyRoute(start, end, cacheKey) {
        const url = `https://api.geoapify.com/v1/routing?waypoints=${start[0]},${start[1]}|${end[0]},${end[1]}&mode=drive&apiKey=${env_1.env.GEOAPIFY_API_KEY}`;
        const response = await this.throttledGet(url);
        if (response.status !== 200 || !response.data.features?.length)
            return null;
        this.isOsrmOnline = true;
        const feature = response.data.features[0];
        const props = feature.properties;
        // Geoapify returns `distance` either as a bare number (meters) or as an
        // object { value, units }. Normalize both shapes.
        const distance = typeof props.distance === 'number'
            ? props.distance
            : Number(props.distance?.value ?? props.distance);
        const duration = props.time;
        const multiplier = ml_eta_service_1.MLEtaService.predictMultiplier(start[0], start[1], distance);
        const rawSteps = this.geoapifyStepsToOsrm(props.legs?.[0]?.steps ?? []);
        const enrichedSteps = (0, road_classifier_1.enrichSteps)(rawSteps);
        const speedLimitsByRoad = this.buildSpeedMap(enrichedSteps);
        const result = {
            distance,
            osrm_duration: duration,
            eta: Math.round(duration * multiplier),
            geometry: feature.geometry,
            steps: enrichedSteps,
            speedLimitsByRoad,
            cache_hit: false,
            model_multiplier: multiplier,
            engine: 'Geoapify'
        };
        await redis_1.redis.set(cacheKey, JSON.stringify(result), 'EX', 600);
        return result;
    }
    static geoapifyStepsToOsrm(steps) {
        if (!Array.isArray(steps))
            return [];
        return steps.map((s) => {
            const name = s.instruction?.text?.split(' onto ').pop()?.split('.')[0]?.trim()
                || s.street_info?.name
                || 'unknown';
            return {
                name,
                distance: s.distance || 0,
                duration: s.duration || 0,
                mode: s.mode || 'driving',
                geometry: null,
                intersections: [],
                maneuver: { type: s.type || 'unknown', modifier: null },
            };
        });
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