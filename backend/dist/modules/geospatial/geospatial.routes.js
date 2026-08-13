"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const geospatial_service_1 = require("./geospatial.service");
const places_service_1 = require("../places/places.service");
const auth_middleware_1 = require("../../middleware/auth.middleware");
const router = (0, express_1.Router)();
/**
 * POST /api/geospatial/route
 * Body: { start: [lat, lng], end: [lat, lng] }
 */
router.post('/route', auth_middleware_1.authMiddleware, async (req, res) => {
    try {
        const { start, end } = req.body;
        if (!start || !end || !Array.isArray(start) || !Array.isArray(end) || start.length !== 2 || end.length !== 2) {
            return res.status(400).json({ error: 'Start and end coordinates are required as [lat, lng] tuples' });
        }
        const route = await geospatial_service_1.GeospatialService.getRoute(start, end);
        res.json(route);
    }
    catch (err) {
        console.error('[GEOSPATIAL] Controller Error:', err.message);
        res.status(500).json({ error: 'Failed to calculate route' });
    }
});
/**
 * GET /api/geospatial/autocomplete
 * Query: q (required, min 2 chars)
 *
 * Returns up to 5 destination suggestions based on common search patterns.
 * Matches are prefix-based: "star" → ["Starbucks"], "mcd" → ["McDonald's"].
 */
router.get('/autocomplete', auth_middleware_1.authMiddleware, async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (q.length < geospatial_service_1.GeospatialService.MIN_AUTOCOMPLETE_LEN) {
            return res.status(400).json({ error: 'Query (q) must be at least 3 characters' });
        }
        const lat = req.query.lat ? parseFloat(req.query.lat) : undefined;
        const lon = req.query.lon ? parseFloat(req.query.lon) : undefined;
        const suggestions = await geospatial_service_1.GeospatialService.autocompleteSearch(q, lat, lon);
        res.json({ suggestions });
    }
    catch (err) {
        console.error('[GEOSPATIAL] Autocomplete Error:', err.message);
        res.status(500).json({ error: 'Failed to get suggestions' });
    }
});
/**
 * GET /api/geospatial/search
 * Query: q, lat, lon
 *
 * Primary: Local PostGIS database with combined text + proximity ranking.
 * Fallback: External API providers (Geoapify → Google Places → static).
 */
router.get('/search', auth_middleware_1.authMiddleware, async (req, res) => {
    try {
        const { q, lat, lon } = req.query;
        if (!q) {
            return res.status(400).json({ error: 'Search query (q) is required' });
        }
        const userLat = lat ? parseFloat(lat) : undefined;
        const userLon = lon ? parseFloat(lon) : undefined;
        // Primary: local PostGIS places database
        let localResults = [];
        try {
            localResults = await places_service_1.PlacesService.search(q, userLat, userLon);
        }
        catch {
            // Places table may not exist yet (migration deferred or PgBouncer blocked)
            // Fall through to API providers.
        }
        if (localResults.length >= 3) {
            return res.json(localResults);
        }
        // Fallback: external API providers
        const apiResults = await geospatial_service_1.GeospatialService.searchPlaces(q, userLat, userLon);
        res.json(apiResults);
    }
    catch (err) {
        console.error('[GEOSPATIAL] Search Controller Error:', err.message);
        res.status(500).json({ error: 'Failed to search places' });
    }
});
/**
 * GET /api/geospatial/inspection-locations
 * Query: zip (required)
 *
 * Geocodes the ZIP via Nominatim (cached in Redis), validates the
 * coordinates are within California, then searches for nearby vehicle
 * inspection stations using the Overpass API with progressive radius
 * expansion (5 → 10 → 25 → 50 km).
 */
router.get('/inspection-locations', auth_middleware_1.authMiddleware, async (req, res) => {
    try {
        const rawZip = (req.query.zip ?? '').replace(/\s+/g, '');
        if (!rawZip) {
            return res.status(400).json({ error: 'ZIP code is required.' });
        }
        if (!/^\d{5}$/.test(rawZip)) {
            return res.status(400).json({ error: 'ZIP code must be exactly 5 digits.' });
        }
        const coords = await geospatial_service_1.GeospatialService.geocodeZip(rawZip);
        if (!coords) {
            return res.status(404).json({
                error: 'This ZIP code could not be found or is outside California. ' +
                    'NetRide vehicle inspections are currently only available in California.',
                code: 'ZIP_NOT_IN_CALIFORNIA',
            });
        }
        const stations = await geospatial_service_1.GeospatialService.findNearbyInspections(coords.lat, coords.lon);
        res.json({
            zip: rawZip,
            lat: coords.lat,
            lon: coords.lon,
            stations,
            count: stations.length,
        });
    }
    catch (err) {
        console.error('[GEOSPATIAL] Inspection locations Controller Error:', err.message);
        res.status(500).json({ error: 'Failed to find inspection locations.' });
    }
});
exports.default = router;
//# sourceMappingURL=geospatial.routes.js.map