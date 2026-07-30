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
    /**
     * All routing flows through the single RoutingService (which owns the
     * provider selection, cache, dedup, retries, and fallback). GeospatialService
     * is a thin adapter that maps the routing result into the legacy `RouteResponse`
     * shape the dispatch / navigation / controller layers expect.
     */
    static getRoute(start: [number, number], end: [number, number], isPreCache?: boolean): Promise<RouteResponse>;
    private static readonly CA_BBOX;
    private static isInCalifornia;
    static geocodeZip(zip: string): Promise<{
        lat: number;
        lon: number;
    } | null>;
    static findNearbyInspections(lat: number, lon: number): Promise<InspectionStation[]>;
    private static readonly GOOGLE_PLACES_BASE;
    private static readonly GEOAPIFY_BASE;
    private static readonly SEARCH_RADII_MILES;
    private static readonly MAX_PLACES;
    private static readonly SEARCH_CACHE_TTL_S;
    private static readonly TEXT_SEARCH_CACHE_TTL_S;
    static readonly MIN_AUTOCOMPLETE_LEN = 2;
    private static readonly MIN_TEXT_SEARCH_LEN;
    private static inFlight;
    private static get googleMapsApiKey();
    /** Google Places Text Search — returns nearby places with coordinates. */
    private static googlePlacesSearchText;
    /** Google Places Query Autocomplete — cheap call, no Place Details.
     *  Uses user's coordinates as approximate location for results.
     *  Place Details ($17/1000) is deferred until user selects a result. */
    private static googlePlacesAutocomplete;
    /** Map common free-text queries to Geoapify category filters. */
    private static geoapifyCategory;
    /**
     * Search for places near the user or get autocomplete suggestions.
     *
     * Tries: Google Places Text Search → Geoapify Places API → Autocomplete fallback.
     */
    static searchPlaces(query: string, userLat?: number, userLon?: number): Promise<any[]>;
    private static _searchPlaces;
    private static cacheSearchResults;
    /**
     * Autocomplete using Google Places, then Geoapify, then static suggestions.
     */
    static autocompleteSearch(query: string, userLat?: number, userLon?: number): Promise<any[]>;
    private static formatGeoapifyName;
    private static haversineMiles;
    static preCacheHotZones(zones: [number, number][]): Promise<void>;
}
export {};
