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
export declare class GeospatialService {
    private static inFlightRequests;
    private static isOsrmOnline;
    private static throttler;
    private static axiosClient;
    private static throttledGet;
    static getRoute(start: [number, number], end: [number, number], isPreCache?: boolean): Promise<RouteResponse>;
    private static readonly CA_BBOX;
    private static isInCalifornia;
    static geocodeZip(zip: string): Promise<{
        lat: number;
        lon: number;
    } | null>;
    static findNearbyInspections(lat: number, lon: number): Promise<InspectionStation[]>;
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
    static searchPlaces(query: string, userLat?: number, userLon?: number): Promise<any[]>;
    private static poiTagFilters;
    private static searchPlacesNearby;
    private static formatPoiName;
    private static searchPlacesNominatim;
    private static fetchAndProcessRoute;
    private static fetchOsrmRoute;
    private static buildSpeedMap;
    private static generateCacheKey;
    private static calculateSyntheticRoute;
    static preCacheHotZones(zones: [number, number][]): Promise<void>;
}
export {};
