export declare class MLEtaService {
    /**
     * Advanced rule-based ETA prediction.
     * Simulates a deep model by accounting for congestion, road types, and non-linear distance friction.
     */
    static predictMultiplier(lat: number, lng: number, distanceMeters: number): number;
}
