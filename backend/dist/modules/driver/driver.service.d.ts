export declare class DriverService {
    static getProfile(userId: string): Promise<any>;
    static getOnboardingProgress(userId: string): Promise<{
        onboarding_step: any;
        phone_verified: any;
        headshot_uploaded: any;
        profile_image_url: any;
        full_name: any;
        date_of_birth: any;
        phone_number: any;
    }>;
    static saveOnboardingStep(userId: string, step: number, data: any): Promise<{
        onboarding_step: any;
        phone_verified: any;
        headshot_uploaded: any;
        profile_image_url: any;
        full_name: any;
        date_of_birth: any;
        phone_number: any;
    }>;
    static completeOnboarding(userId: string): Promise<{
        success: boolean;
        message: string;
    }>;
    static onboard(userId: string, data: any): Promise<any>;
    static updateOperatingClass(userId: string, activeClass: string): Promise<any>;
    /**
     * Returns the driver's verified vehicle class plus the full list of ride
     * types they are ELIGIBLE to receive (derived, not user-selected) and their
     * current per-ride-type preferences (enabled/disabled).
     */
    static getRidePreferences(userId: string): Promise<{
        vehicleClass: any;
        eligibleRideTypes: import("../../types").VehicleClass[];
        allRideTypes: import("../../types").VehicleClass[];
        preferences: Record<string, boolean>;
    }>;
    /**
     * Persists the driver's ride-type preferences. Only ELIGIBLE ride types may
     * be configured; any ineligible type in the payload is ignored to prevent
     * invalid combinations. `enabled` is the list of ride types the driver
     * wishes to receive; everything else eligible is disabled.
     */
    static setRidePreferences(userId: string, enabled: string[]): Promise<{
        vehicleClass: any;
        eligibleRideTypes: import("../../types").VehicleClass[];
        allRideTypes: import("../../types").VehicleClass[];
        preferences: Record<string, boolean>;
    }>;
    static getRecommendations(userId: string): Promise<{
        recommended_class: import("../../types").VehicleClass;
        reason: string;
    } | null>;
    static updateProfile(userId: string, data: any): Promise<any>;
    static requestVerification(userId: string, data: any): Promise<any>;
    static getVehicles(): Promise<any[]>;
    static getPricing(userId: string): Promise<{
        price_per_mile: number;
        price_range_min: number;
        price_range_max: number;
        recommended_price: number;
        price_last_changed: Date | null | undefined;
    }>;
    static updatePrice(userId: string, pricePerMile: number): Promise<{
        price_per_mile: number;
        price_range_min: number;
        price_range_max: number;
        recommended_price: number;
        price_last_changed: Date | null;
    }>;
    static submitProfileChange(userId: string, changes: any, reason?: string): Promise<{
        request_id: any;
        status: string;
        has_pending: boolean;
        queued_changes: string[];
        card_last4: string | null;
        card_brand: string | null;
    }>;
    static getCurrentProfileChange(userId: string): Promise<{
        status: string;
        request_id?: undefined;
        created_at?: undefined;
        reviewed_at?: undefined;
        rejection_reason?: undefined;
        changes?: undefined;
        card_last4?: undefined;
        card_brand?: undefined;
    } | {
        request_id: any;
        status: any;
        created_at: any;
        reviewed_at: any;
        rejection_reason: any;
        changes: any;
        card_last4: any;
        card_brand: any;
    }>;
    static addPayoutCard(userId: string, payload: any): Promise<{
        card_id: any;
        status: string;
        brand: import("../../utils/card").CardBrandName;
        last4: string;
        exp_month: any;
        exp_year: any;
    }>;
    static getWallet(userId: string): Promise<{
        balance_cents: number;
        lifetime_earnings_cents: number;
        payout_card: any;
        recent_payouts: any[];
    }>;
    static requestOnDemandPayout(userId: string, amountCents: number): Promise<{
        payout_id: string;
        amount_cents: number;
        fee_cents: number;
        net_cents: number;
        status: string;
        method: string;
    }>;
    static listMyPayouts(userId: string, limit: number, offset: number): Promise<{
        payouts: any[];
        total: any;
    }>;
    static submitNewVehicle(userId: string, data: any): Promise<{
        success: boolean;
        submission: any;
    }>;
    static getPendingVehicleSubmissions(userId: string): Promise<{
        submissions: any[];
    }>;
    static getVehicleResubmissionRequirements(userId: string): Promise<{
        requirements: any[];
        has_action_required: boolean;
    }>;
    static submitVehicleResubmission(userId: string, data: any, resubmissionRequestId?: string): Promise<{
        success: boolean;
        submission: any;
    }>;
    /**
     * Returns the driver's authoritative active/approved vehicle.
     * Legacy rows with NULL vehicle_status are treated as APPROVED.
     * Returns null if no active vehicle exists.
     */
    static getActiveVehicle(driverId: string): Promise<any>;
    /**
     * Returns the latest finalized vehicle submission (Approved or Rejected)
     * for admin review purposes. This is distinct from the active vehicle.
     */
    static getLatestFinalizedVehicleSubmission(driverId: string): Promise<any>;
    /**
     * Returns the latest vehicle submission (any status) for the driver.
     */
    static getLatestVehicleSubmission(driverId: string): Promise<any>;
    static getDocumentRequirements(userId: string): Promise<{
        requirements: any[];
        has_action_required: boolean;
    }>;
    /**
     * Submit one or more new document URLs for admin review.
     * `newDocumentUrls` must be a non-empty array of strings (URLs).
     * When multiple URLs are provided they are stored as a JSON array in
     * `new_document_url` so the admin UI can display all submitted images.
     */
    static resubmitDocument(userId: string, requirementId: string, newDocumentUrls: string[]): Promise<{
        success: boolean;
        requirement: any;
    }>;
    /**
     * Atomically submit multiple document requirements in a single transaction.
     * All submissions succeed or none do — partial failures are rolled back.
     */
    static batchResubmitDocuments(userId: string, submissions: Array<{
        requirementId: string;
        newDocumentUrls: string[];
    }>): Promise<{
        success: boolean;
    }>;
    /**
     * Idempotent ride-completion wallet credit. Safe to call multiple times
     * for the same ride — the unique index on payouts(ride_id) WHERE
     * method='RIDE_CREDIT' prevents double-counting.
     */
    static creditOnRideComplete(driverId: string, fareCents: number, rideId: string): Promise<void>;
}
