export interface RouteResponse {
    distance: number;
    osrm_duration: number;
    eta: number;
    geometry: any;
    cache_hit: boolean;
    model_multiplier: number;
    engine: string;
}
export declare class GeospatialService {
    private static inFlightRequests;
    private static isOsrmOnline;
    private static axiosClient;
    static getRoute(start: [number, number], end: [number, number], isPreCache?: boolean): Promise<RouteResponse>;
    private static fetchAndProcessRoute;
    private static generateCacheKey;
    private static calculateSyntheticRoute;
    static preCacheHotZones(zones: [number, number][]): Promise<void>;
}
