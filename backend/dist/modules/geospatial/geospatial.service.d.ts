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
    private static readonly GOOGLE_PLACES_NEW;
    private static readonly GEOAPIFY_BASE;
    private static readonly SEARCH_RADII_MILES;
    private static readonly MAX_PLACES;
    private static readonly SEARCH_CACHE_TTL_S;
    private static readonly TEXT_SEARCH_CACHE_TTL_S;
    static readonly MIN_AUTOCOMPLETE_LEN = 1;
    private static readonly MIN_TEXT_SEARCH_LEN;
    private static inFlight;
    private static get googleMapsApiKey();
    /** Google Places Text Search (New API) — returns nearby places with coordinates.
     *  Uses Places API (New) endpoint which is enabled on the existing API key.
     *  See: https://developers.google.com/maps/documentation/places/web-service/text-search */
    private static googlePlacesSearchText;
    /** Google Places Autocomplete (New API) — cheap call ($2.83/1000), no Place Details.
     *  Uses Places API (New) endpoint, defers coordinate resolution until user selects result.
     *  See: https://developers.google.com/maps/documentation/places/web-service/autocomplete */
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
    /** Geoapify Geocoding Autocomplete — PRIMARY provider. Returns real nearby coordinates. */
    private static geoapifyAutocomplete;
    /**
     * Autocomplete search using local PostGIS database (primary) with Google Places as fallback.
     * Uses PostGIS for nearby places with text matching + proximity ranking.
     */
    static autocompleteSearch(query: string, userLat?: number, userLon?: number): Promise<any[]>;
    /** Sort results by distance (closest first). Results without distance go last. */
    private static sortByDistance;
    private static formatGeoapifyName;
    private static haversineMiles;
    static preCacheHotZones(zones: [number, number][]): Promise<void>;
}
export {};
