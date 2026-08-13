import { Response } from 'express';
export declare class RideController {
    static requestRide(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static estimateRide(req: any, res: Response): Promise<void>;
    static acceptTrip(req: any, res: Response): Promise<void>;
    static rateRide(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static getHistory(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static deleteHistory(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * The user's active trip (any non-terminal status), role-aware. Used by
     * the rider app to hydrate the trip screen when it is opened from a push
     * notification deep link (e.g. "Your driver has arrived" → /trip).
     */
    static getCurrent(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * Idempotent cancel of the rider's current request, by rider identity —
     * no tripId needed. The Flutter client calls this when the rider hits the
     * top-right X / Cancel Ride during "searching", where a race can leave the
     * client without a tripId yet (the socket tripUpdate round-trip). Always
     * returns 200 when there is nothing active to cancel.
     */
    static cancelCurrentRide(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * Verify the caller is a party to the trip. Throws nothing — returns
     * a discriminated response shape so the caller can decide between
     * 403 (not a party), 404 (no such trip), and 200 (allowed).
     *
     * `role` is optional: the Twilio webhook path doesn't have a JWT
     * (the access token IS the auth) and we want to do a row-level
     * "is this user on this trip at all" check rather than reject
     * because the caller didn't say which role they are.
     */
    private static assertTripParty;
    static getTripMessages(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static mintCallToken(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * Twilio Voice SDK calls into this endpoint (the TwiML App URL) to
     * learn how to route the outbound leg. We always answer with a
     * <Dial><Conference> pointing at the trip's conference room. The
     * SDK-supplied "To" parameter is ignored — security lives in the
     * access-token grant.
     */
    static callConnectTwiML(req: any, res: Response): Promise<void>;
    /**
     * Webhook for Twilio status callbacks. We log but don't act on them
     * here — billing-side metrics live in the Twilio console. Endpoint
     * exists so Twilio's request signature validation can succeed.
     */
    static callStatusCallback(req: any, res: Response): Promise<void>;
}
