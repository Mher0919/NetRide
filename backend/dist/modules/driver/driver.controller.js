"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DriverController = void 0;
const driver_service_1 = require("./driver.service");
const zod_1 = require("zod");
const vehicleData_service_1 = require("../../services/vehicleData.service");
// Accepts either a full URL or a relative /api/files/{id} path.
const fileUrlSchema = () => zod_1.z.string().refine(v => v.startsWith('/api/files/') || zod_1.z.string().url().safeParse(v).success, { message: 'Must be a valid URL or /api/files/{id} path' });
const OnboardSchema = zod_1.z.object({
    personalInfo: zod_1.z.object({
        full_name: zod_1.z.string().optional(),
        phone_number: zod_1.z.string(),
        date_of_birth: zod_1.z.string(),
        profile_image_url: fileUrlSchema(),
    }),
    identity: zod_1.z.object({
        license_photo_url: fileUrlSchema(),
        license_photo_back_url: fileUrlSchema(),
        insurance_photo_url: fileUrlSchema(),
        registration_photo_url: fileUrlSchema(),
    }),
    vehicle: zod_1.z.object({
        license_plate_number: zod_1.z.string(),
        license_plate_state: zod_1.z.string().optional(),
        zip_code: zod_1.z.string().optional(),
        make: zod_1.z.string().optional(),
        model: zod_1.z.string().optional(),
        year: zod_1.z.number().optional(),
        color: zod_1.z.string().optional(),
        interior_color: zod_1.z.string().optional(),
    }),
});
const UpdateProfileSchema = zod_1.z.object({
    full_name: zod_1.z.string().optional(),
    phone_number: zod_1.z.string().optional(),
    date_of_birth: zod_1.z.string().optional(),
    profile_image_url: fileUrlSchema().optional(),
    license_number: zod_1.z.string().optional(),
    license_expiry_date: zod_1.z.string().optional(),
    vehicle_id: zod_1.z.string().uuid().optional(),
    license_plate_number: zod_1.z.string().optional(),
    make: zod_1.z.string().optional(),
    model: zod_1.z.string().optional(),
    year: zod_1.z.number().optional(),
    color: zod_1.z.string().optional(),
    interior_color: zod_1.z.string().optional(),
});
const VerifyIdentitySchema = zod_1.z.object({
    license_photo_url: fileUrlSchema(),
    license_photo_back_url: fileUrlSchema(),
    date_of_birth: zod_1.z.string().optional(),
    license_number: zod_1.z.string().optional(),
});
const ProfileChangeChangesSchema = zod_1.z.object({
    full_name: zod_1.z.string().min(2).max(80).optional(),
    phone_number: zod_1.z.string().regex(/^\+?[0-9 ()\-]{7,20}$/).optional(),
    date_of_birth: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    profile_image_url: fileUrlSchema().optional(),
    license_number: zod_1.z.string().min(3).max(40).optional(),
    license_plate_number: zod_1.z.string().min(1).max(15).optional(),
    license_plate_photo_url: fileUrlSchema().optional(),
    inspection_photo_url: fileUrlSchema().optional(),
    car_photo_urls: zod_1.z.array(fileUrlSchema()).max(4).optional(),
    make: zod_1.z.string().min(1).max(40).optional(),
    model: zod_1.z.string().min(1).max(40).optional(),
    year: zod_1.z.number().int().min(2011).max(new Date().getFullYear() + 1).optional(),
    color: zod_1.z.string().min(1).max(40).optional(),
    interior_color: zod_1.z.string().min(1).max(40).optional(),
    payout_card: zod_1.z.object({
        card_number: zod_1.z.string().min(13).max(19),
        exp_month: zod_1.z.number().int().min(1).max(12),
        exp_year: zod_1.z.number().int().min(2024).max(2099),
        cvc: zod_1.z.string().regex(/^\d{3,4}$/),
        cardholder_name: zod_1.z.string().min(2).max(80),
        zip: zod_1.z.string().min(3).max(12),
    }).optional(),
}).refine(c => Object.keys(c).length > 0, 'At least one field must be provided');
const ProfileChangeRequestSchema = zod_1.z.object({
    changes: ProfileChangeChangesSchema,
    reason: zod_1.z.string().min(1).max(500).optional(),
});
const PayoutCardSchema = zod_1.z.object({
    card_number: zod_1.z.string().min(13).max(19),
    exp_month: zod_1.z.number().int().min(1).max(12),
    exp_year: zod_1.z.number().int().min(2024).max(2099),
    cvc: zod_1.z.string().regex(/^\d{3,4}$/),
    cardholder_name: zod_1.z.string().min(2).max(80),
    zip: zod_1.z.string().min(3).max(12),
});
const PayoutRequestSchema = zod_1.z.object({
    amount_cents: zod_1.z.number().int().positive().max(10000000),
});
const SubmitNewVehicleSchema = zod_1.z.object({
    make: zod_1.z.string().min(1, 'Vehicle make is required'),
    model: zod_1.z.string().min(1, 'Vehicle model is required'),
    year: zod_1.z.number().int().min(2011, 'Vehicle must be 2011 or newer'),
    color: zod_1.z.string().min(1, 'Color is required'),
    interior_color: zod_1.z.string().optional(),
    // Verified classification inputs used by the eligibility engine.
    seats: zod_1.z.number().int().min(1).max(15).optional(),
    is_luxury: zod_1.z.boolean().optional(),
    license_plate_number: zod_1.z.string().min(1, 'License plate is required'),
    license_plate_state: zod_1.z.string().min(1, 'License plate state is required'),
    zip_code: zod_1.z.string().min(1, 'ZIP code is required'),
    registration_photo_url: zod_1.z.string().url('Valid registration photo URL is required'),
    insurance_photo_url: zod_1.z.string().url('Valid insurance photo URL is required'),
    inspection_photo_url: zod_1.z.string().url('Valid inspection photo URL is required'),
});
class DriverController {
    static async getOnboardingProgress(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Please log in to view your onboarding progress.' });
            const progress = await driver_service_1.DriverService.getOnboardingProgress(userId);
            res.json(progress);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ Onboarding progress error: ${error.message}`);
            res.status(500).json({ error: 'Failed to load onboarding progress.' });
        }
    }
    static async saveOnboardingStep(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const { step, data } = req.body;
            if (typeof step !== 'number' || step < 0 || step > 5) {
                return res.status(400).json({ error: 'Invalid onboarding step.' });
            }
            if (!data || typeof data !== 'object') {
                return res.status(400).json({ error: 'Step data is required.' });
            }
            const result = await driver_service_1.DriverService.saveOnboardingStep(userId, step, data);
            res.json(result);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ Save step error: ${error.message}`);
            res.status(400).json({ error: error.message || 'Failed to save onboarding step.' });
        }
    }
    static async completeOnboarding(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const result = await driver_service_1.DriverService.completeOnboarding(userId);
            res.json(result);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ Complete onboarding error: ${error.message}`);
            res.status(400).json({ error: error.message || 'Failed to complete onboarding. Please ensure all steps are finished.' });
        }
    }
    static async getProfile(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Please log in to view your profile.' });
            const profile = await driver_service_1.DriverService.getProfile(userId);
            res.json(profile);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ Profile fetch error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve profile information.' });
        }
    }
    static async updateProfile(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const validatedData = UpdateProfileSchema.parse(req.body);
            const result = await driver_service_1.DriverService.updateProfile(userId, validatedData);
            res.json(result);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ Profile update error: ${error.message}`);
            res.status(400).json({ error: error.message.includes('not found') ? 'Profile not found.' : 'Failed to update profile. Please check your information.' });
        }
    }
    static async verifyIdentity(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const validatedData = VerifyIdentitySchema.parse(req.body);
            const result = await driver_service_1.DriverService.requestVerification(userId, validatedData);
            res.json(result);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ Identity verification error: ${error.message}`);
            res.status(400).json({ error: error.message || 'Failed to submit identity verification.' });
        }
    }
    static async onboard(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const validatedData = OnboardSchema.parse(req.body);
            const result = await driver_service_1.DriverService.onboard(userId, validatedData);
            res.json(result);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ Onboarding error: ${error.message}`);
            res.status(400).json({ error: error.message || 'Onboarding failed. Please ensure all required documents are uploaded.' });
        }
    }
    static async getVehicles(req, res) {
        try {
            const vehicles = await driver_service_1.DriverService.getVehicles();
            res.json(vehicles);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ Vehicles fetch error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve available vehicles.' });
        }
    }
    static async searchVehicleModels(req, res) {
        try {
            const query = req.query.q;
            const results = await vehicleData_service_1.VehicleDataService.searchVehicles(query);
            res.json(results);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ Model search error: ${error.message}`);
            res.status(500).json({ error: 'Failed to search for vehicle models.' });
        }
    }
    static async getVehicleYears(req, res) {
        try {
            // Returns years from 2011 to current year + 1
            const currentYear = new Date().getFullYear();
            const years = [];
            for (let y = currentYear + 1; y >= 2011; y--) {
                years.push(y);
            }
            res.json(years);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ Years fetch error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve vehicle years.' });
        }
    }
    static async getVehicleMakes(req, res) {
        try {
            const makes = await vehicleData_service_1.VehicleDataService.getMakes();
            res.json(makes);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ Makes fetch error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve vehicle makes.' });
        }
    }
    static async getVehicleModelsByMake(req, res) {
        try {
            const make = req.query.make;
            if (!make)
                return res.status(400).json({ error: 'Make is required to find models.' });
            const models = await vehicleData_service_1.VehicleDataService.getModels(make);
            res.json(models);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ Models fetch error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve vehicle models.' });
        }
    }
    static async submitProfileChange(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const validated = ProfileChangeRequestSchema.parse(req.body);
            const result = await driver_service_1.DriverService.submitProfileChange(userId, validated.changes, validated.reason);
            res.json(result);
        }
        catch (error) {
            if (error?.name === 'ZodError') {
                return res.status(400).json({ error: 'Invalid request payload.', details: error.errors });
            }
            const msg = error?.message ?? 'Failed to submit profile change.';
            const code = msg.includes('PROFILE_CHANGE_PENDING') ? 409
                : msg.includes('RATE_LIMITED') ? 429
                    : msg.includes('PHONE_NOT_VERIFIED') ? 400
                        : 400;
            console.error(`[DRIVER] ❌ Submit profile change error: ${msg}`);
            res.status(code).json({ error: msg });
        }
    }
    static async getCurrentProfileChange(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const result = await driver_service_1.DriverService.getCurrentProfileChange(userId);
            res.json(result);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ Current profile change error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve current profile change.' });
        }
    }
    static async addPayoutCard(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const validated = PayoutCardSchema.parse(req.body);
            const result = await driver_service_1.DriverService.addPayoutCard(userId, validated);
            res.json(result);
        }
        catch (error) {
            if (error?.name === 'ZodError') {
                return res.status(400).json({ error: 'Invalid card details.', details: error.errors });
            }
            const msg = error?.message ?? 'Failed to submit payout card.';
            const code = msg.includes('INVALID_CARD') ? 400 : 400;
            console.error(`[DRIVER] ❌ Add payout card error: ${msg}`);
            res.status(code).json({ error: msg });
        }
    }
    static async getWallet(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const result = await driver_service_1.DriverService.getWallet(userId);
            res.json(result);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ Wallet fetch error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve wallet.' });
        }
    }
    static async requestOnDemandPayout(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const validated = PayoutRequestSchema.parse(req.body);
            const result = await driver_service_1.DriverService.requestOnDemandPayout(userId, validated.amount_cents);
            res.json(result);
        }
        catch (error) {
            if (error?.name === 'ZodError') {
                return res.status(400).json({ error: 'Invalid payout request.' });
            }
            const msg = error?.message ?? 'Failed to request payout.';
            const code = msg.includes('NO_PAYOUT_CARD') ? 403
                : msg.includes('INSUFFICIENT_BALANCE') ? 400
                    : msg.includes('MIN_PAYOUT') ? 400
                        : 400;
            console.error(`[DRIVER] ❌ Request payout error: ${msg}`);
            res.status(code).json({ error: msg });
        }
    }
    static async listMyPayouts(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
            const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
            const result = await driver_service_1.DriverService.listMyPayouts(userId, limit, offset);
            res.json(result);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ List payouts error: ${error.message}`);
            res.status(500).json({ error: 'Failed to list payouts.' });
        }
    }
    static async getDocumentRequirements(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const result = await driver_service_1.DriverService.getDocumentRequirements(userId);
            res.json(result);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ Document requirements error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve document requirements.' });
        }
    }
    static async resubmitDocument(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const { requirementId, newDocumentUrl, newDocumentUrls } = req.body;
            const urls = newDocumentUrls ?? (newDocumentUrl ? [newDocumentUrl] : []);
            if (!requirementId || urls.length === 0) {
                return res.status(400).json({ error: 'Requirement ID and at least one document URL are required.' });
            }
            const result = await driver_service_1.DriverService.resubmitDocument(userId, requirementId, urls);
            res.json(result);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ Document resubmission error: ${error.message}`);
            res.status(400).json({ error: error.message || 'Failed to resubmit document.' });
        }
    }
    static async batchResubmitDocuments(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const { submissions } = req.body;
            if (!Array.isArray(submissions) || submissions.length === 0) {
                return res.status(400).json({ error: 'At least one document submission is required.' });
            }
            const result = await driver_service_1.DriverService.batchResubmitDocuments(userId, submissions);
            res.json(result);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ Batch document resubmission error: ${error.message}`);
            res.status(400).json({ error: error.message || 'Failed to resubmit documents.' });
        }
    }
    static async submitNewVehicle(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const validated = SubmitNewVehicleSchema.parse(req.body);
            const result = await driver_service_1.DriverService.submitNewVehicle(userId, validated);
            res.status(201).json(result);
        }
        catch (error) {
            if (error?.name === 'ZodError') {
                return res.status(400).json({ error: 'Invalid vehicle data.', details: error.errors });
            }
            console.error(`[DRIVER] ❌ Submit new vehicle error: ${error.message}`);
            res.status(400).json({ error: error.message || 'Failed to submit new vehicle.' });
        }
    }
    static async getPendingVehicleSubmissions(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const result = await driver_service_1.DriverService.getPendingVehicleSubmissions(userId);
            res.json(result);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ Pending vehicle error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve pending vehicle submissions.' });
        }
    }
    static async getVehicleResubmissionRequirements(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const result = await driver_service_1.DriverService.getVehicleResubmissionRequirements(userId);
            res.json(result);
        }
        catch (error) {
            console.error(`[DRIVER] ❌ Vehicle resubmission requirements error: ${error.message}`);
            res.status(500).json({ error: 'Failed to retrieve vehicle resubmission requirements.' });
        }
    }
    static async submitVehicleResubmission(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const validated = SubmitNewVehicleSchema.parse(req.body);
            const { resubmissionRequestId } = req.body;
            const result = await driver_service_1.DriverService.submitVehicleResubmission(userId, validated, resubmissionRequestId);
            res.status(201).json(result);
        }
        catch (error) {
            if (error?.name === 'ZodError') {
                return res.status(400).json({ error: 'Invalid vehicle data.', details: error.errors });
            }
            console.error(`[DRIVER] ❌ Submit vehicle resubmission error: ${error.message}`);
            res.status(400).json({ error: error.message || 'Failed to submit vehicle resubmission.' });
        }
    }
}
exports.DriverController = DriverController;
//# sourceMappingURL=driver.controller.js.map