import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
export declare class AdminController {
    private static toJSON;
    static getStats(req: AuthRequest, res: Response): Promise<void>;
    static listFleets(req: AuthRequest, res: Response): Promise<void>;
    static createFleet(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static updateFleet(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    /** Assign (fleet_id) or unassign (null) a driver to/from a fleet. */
    static assignDriverFleet(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static listPricingProfiles(req: AuthRequest, res: Response): Promise<void>;
    /** Update a profile's rates; the 60s engine cache is busted immediately. */
    static updatePricingProfile(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static getRevenueOverview(req: AuthRequest, res: Response): Promise<void>;
    static getUsers(req: AuthRequest, res: Response): Promise<void>;
    /**
     * Admin view of a driver's ride eligibility. NetRide operates a single
     * NetRide Premium — every approved vehicle is eligible.
     */
    static getDriverRidePreferences(req: AuthRequest, res: Response): Promise<void>;
    static getUserById(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static verifyUser(req: AuthRequest, res: Response): Promise<void>;
    static rejectUser(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static setPending(req: AuthRequest, res: Response): Promise<void>;
    static blockUser(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static unblockUser(req: AuthRequest, res: Response): Promise<void>;
    static getFlaggedRatings(req: AuthRequest, res: Response): Promise<void>;
    static getLogs(req: AuthRequest, res: Response): Promise<void>;
    static getRides(req: AuthRequest, res: Response): Promise<void>;
    static getRideById(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * Operator escape hatch: dissolve a stuck ride (e.g. a driver killed the
     * app mid-trip and the automatic stale-ride watchdog has not yet fired).
     * Terminates the ride, broadcasts the authoritative CANCELLED payload to
     * both apps + monitoring, releases the driver lock/navigation state and
     * writes an audit log entry.
     */
    static cancelRide(req: AuthRequest, res: Response): Promise<void>;
    /**
     * Operator escape hatch: force-complete a stuck ride that reached its
     * destination (or the rider/driver situation is unambiguous). Runs the
     * full completion pipeline — wallet credit, financial ledger, rewards,
     * safety teardown — exactly as a driver-initiated completion would.
     */
    static completeRide(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static verifyInspection(req: AuthRequest, res: Response): Promise<void>;
    static getRideAudit(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * Planned + actually-driven routes for a ride, for admin map rendering.
     *
     * planned: per-leg polylines from ride_routes (the rider-generated
     *   Google/OSRM route stored at request time), with a fallback to the
     *   destination-leg mirror in rides.route_metadata.
     * actual:  the GPS samples captured during the trip (Redis trajectory
     *   buffer, snapshotted into rides.trajectory at completion). Marked
     *   available only when ≥ 2 valid points exist — a ride with no GPS
     *   samples reports actualRoute.available = false so the frontend never
     *   labels the planned route as the driven one.
     *
     * Coordinates are returned as [lat, lng] pairs; GeoJSON [lng, lat]
     * storage is converted here.
     */
    static getRideRoutes(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * Full financial picture for one ride: the settlement ledger row
     * (financial_transactions), the rider wallet movements and the driver
     * earnings rows (payouts RIDE_CREDIT / TIP_CREDIT). Money is returned
     * as numbers (cents). Only the backend decides these amounts.
     */
    static getRideLedger(req: AuthRequest, res: Response): Promise<void>;
    /**
     * Driver earnings from the settlement ledger — the only source the admin
     * UI may use for driver income. Only SETTLED rows count (a cancelled or
     * unpaid ride contributes $0). Returns lifetime + range totals, a
     * server-bucketed time series (UTC buckets) and paginated completed
     * rides. All money is integer cents.
     */
    static getDriverEarnings(req: AuthRequest, res: Response): Promise<void>;
    /**
     * Ledger-driven revenue analytics: platform/driver/gross totals plus a
     * server-bucketed time series and per-ride averages. SETTLED settlements
     * only — cancelled, unpaid or still-pending rides contribute $0 (the
     * backend decides, never the client).
     *
     * range:  7d | 30d | 90d | all   (completed_at >= NOW() - range)
     * bucket: day | week | month     (server-side date_trunc, UTC buckets —
     *                                 the documented analytics convention;
     *                                 the frontend formats for display)
     * region: optional region code — filters by pickup-point geofence
     *         (region_contains on the region center/radius).
     */
    static getRevenueAnalytics(req: AuthRequest, res: Response): Promise<void>;
    /** List active regions (used for the analytics region filter). */
    static listRegions(req: AuthRequest, res: Response): Promise<void>;
    /** Create / update a region (admin-only). Validated server-side. */
    static upsertRegion(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static getLiveDrivers(req: AuthRequest, res: Response): Promise<void>;
    /**
     * Fleet-wide view of recent speeding violations, newest first.
     * Used by the /speeding admin dashboard.
     */
    static getSpeedingViolations(req: AuthRequest, res: Response): Promise<void>;
    /**
     * Per-driver speeding history. Used in UserDetail's Safety section.
     */
    static getDriverSpeeding(req: AuthRequest, res: Response): Promise<void>;
    /**
     * List drivers flagged as dangerous. Includes violation counts so
     * the admin list view can sort by severity.
     */
    static getDangerousDrivers(req: AuthRequest, res: Response): Promise<void>;
    /**
     * Manually clear the dangerous flag after admin review (warning
     * issued, retraining completed, etc). Writes an audit_log row.
     */
    static clearDangerousFlag(req: AuthRequest, res: Response): Promise<void>;
    static updateLicense(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static listProfileChanges(req: AuthRequest, res: Response): Promise<void>;
    static getProfileChange(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static approveProfileChange(req: AuthRequest, res: Response): Promise<void>;
    static rejectProfileChange(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static listPayoutCards(req: AuthRequest, res: Response): Promise<void>;
    static approvePayoutCard(req: AuthRequest, res: Response): Promise<void>;
    static rejectPayoutCard(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static requestDocumentResubmission(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static getDriverDocumentRequirements(req: AuthRequest, res: Response): Promise<void>;
    static reviewDocumentRequirement(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static listVehicleSubmissions(req: AuthRequest, res: Response): Promise<void>;
    static getVehicleSubmission(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static approveVehicleSubmission(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static rejectVehicleSubmission(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static requestVehicleChanges(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * Request a full vehicle resubmission for the driver.
     * Creates a resubmission request, marks action required on the driver,
     * and sets the driver_vehicles row to RESUBMISSION_REQUIRED.
     * Unlike requestVehicleChanges (which targets a specific pending submission),
     * this can be used to request a completely new vehicle submission
     * even for previously approved/rejected vehicles.
     */
    static requestVehicleResubmission(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static listPayouts(req: AuthRequest, res: Response): Promise<void>;
    static markPayoutPaid(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    /** Allowed document fields and which table+column they map to. */
    private static readonly DOCUMENT_FIELDS;
    static uploadUserDocument(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static deleteUserDocument(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static listReports(req: AuthRequest, res: Response): Promise<void>;
    static resolveReport(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
}
