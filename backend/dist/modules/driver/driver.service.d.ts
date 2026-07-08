export declare class DriverService {
    static getProfile(userId: string): Promise<any>;
    static onboard(userId: string, data: any): Promise<any>;
    static updateOperatingClass(userId: string, activeClass: string): Promise<any>;
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
    static submitProfileChange(userId: string, changes: any): Promise<{
        request_id: string;
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
    /**
     * Idempotent ride-completion wallet credit. Safe to call multiple times
     * for the same ride — the unique index on payouts(ride_id) WHERE
     * method='RIDE_CREDIT' prevents double-counting.
     */
    static creditOnRideComplete(driverId: string, fareCents: number, rideId: string): Promise<void>;
}
