import { Response } from 'express';
export declare class DriverController {
    static getOnboardingProgress(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static saveOnboardingStep(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static completeOnboarding(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static getProfile(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static updateProfile(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static verifyIdentity(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static onboard(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static getVehicles(req: any, res: Response): Promise<void>;
    static searchVehicleModels(req: any, res: Response): Promise<void>;
    static getVehicleYears(req: any, res: Response): Promise<void>;
    static getVehicleMakes(req: any, res: Response): Promise<void>;
    static getVehicleModelsByMake(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static submitProfileChange(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static getCurrentProfileChange(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static addPayoutCard(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static getWallet(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static requestOnDemandPayout(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static listMyPayouts(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static getDocumentRequirements(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static resubmitDocument(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static batchResubmitDocuments(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static submitNewVehicle(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static getPendingVehicleSubmissions(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static getVehicleResubmissionRequirements(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    static submitVehicleResubmission(req: any, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
}
