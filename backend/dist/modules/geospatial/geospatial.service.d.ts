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
    static searchPlaces(query: string, userLat?: number, userLon?: number): Promise<any[]>;
    private static fetchAndProcessRoute;
    private static fetchOsrmRoute;
    private static fetchGeoapifyRoute;
    private static geoapifyStepsToOsrm;
    private static buildSpeedMap;
    private static generateCacheKey;
    private static calculateSyntheticRoute;
    static preCacheHotZones(zones: [number, number][]): Promise<void>;
}
export {};
