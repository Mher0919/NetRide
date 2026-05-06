"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const geospatial_service_1 = require("./geospatial.service");
const router = (0, express_1.Router)();
/**
 * POST /api/geospatial/route
 * Body: { start: [lat, lng], end: [lat, lng] }
 */
router.post('/route', async (req, res) => {
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
exports.default = router;
//# sourceMappingURL=geospatial.routes.js.map